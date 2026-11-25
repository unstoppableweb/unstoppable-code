import type { JSX } from 'react';
import {
  COST_NOT_PRICED_LABEL,
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
  // A part with no dollars stays when it has unpriced records (an
  // organization gateway): it reads `Not priced`, with no share, and stays
  // out of the share total.
  const visibleSegments = segments.filter(
    (segment) => segment.value > 0 || isNotPricedSegment(segment),
  );
  const total = visibleSegments.reduce(
    (sum, segment) => sum + Math.max(segment.value, 0),
    0,
  );
  const amount = (segment: CostSegment): string =>
    isNotPricedSegment(segment)
      ? COST_NOT_PRICED_LABEL
      : formatCostSegmentIn(segment, currency);
  const share = (segment: CostSegment): string | undefined =>
    showShare && !isNotPricedSegment(segment)
      ? formatCostShare(segment.value, total)
      : undefined;

  if (layout === 'list') {
    return (
      <ValueRows dataTestId={testId}>
        {visibleSegments.map((segment) => (
          <ValueRow
            key={segment.key}
            swatch={segment.color}
            label={segment.label}
            value={amount(segment)}
            share={share(segment)}
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
          detail={share(segment)}
          numeric
        >
          {amount(segment)}
        </Fact>
      ))}
    </FactList>
  );
}

function isNotPricedSegment(segment: CostSegment): boolean {
  return segment.value <= 0 && (segment.notPricedCount ?? 0) > 0;
}
