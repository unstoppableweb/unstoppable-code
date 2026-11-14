import type { JSX } from 'react';
import {
  formatCostSegmentIn,
  formatCostShare,
  type CostSegment,
} from './cost-format';
import { useCostCurrency } from './CostCurrencyContext';
import { Fact, FactList } from '../FactList';
import { ValueRow, ValueRows } from '../settings/ValueRows';

export interface CostLegendProps {
  readonly segments: readonly CostSegment[];
  /** Adds each part's share of the total (sum of segments). */
  readonly showShare?: boolean;
  /** `inline`: one wrapping line of parts, a chart legend (the panel and Activity summary). `list`: one value row per part, label left, amount and share right-aligned (the popover and breakdown; design call 1C). */
  readonly layout?: 'inline' | 'list';
  readonly testId?: string;
}

export function CostLegend({
  segments,
  showShare = false,
  layout = 'inline',
  testId,
}: CostLegendProps): JSX.Element {
  const currency = useCostCurrency();
  const visibleSegments = segments.filter((segment) => segment.value > 0);
  const total = visibleSegments.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );

  if (layout === 'list') {
    return (
      <ValueRows dataTestId={testId}>
        {visibleSegments.map((segment) => (
          <ValueRow
            key={segment.key}
            swatch={segment.color}
            label={segment.label}
            value={formatCostSegmentIn(segment, currency)}
            share={
              showShare ? formatCostShare(segment.value, total) : undefined
            }
          />
        ))}
      </ValueRows>
    );
  }

  // A chart legend: one wrapping line under the bar it explains.
  return (
    <FactList
      layout="inline"
      rowGap="1"
      columnGap="3"
      labelTone="secondary"
      dataTestId={testId}
    >
      {visibleSegments.map((segment) => (
        <Fact
          key={segment.key}
          label={segment.label}
          swatch={segment.color}
          detail={showShare ? formatCostShare(segment.value, total) : undefined}
          numeric
        >
          {formatCostSegmentIn(segment, currency)}
        </Fact>
      ))}
    </FactList>
  );
}
