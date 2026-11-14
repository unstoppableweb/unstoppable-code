import type { JSX } from 'react';
import { SegmentsBar } from '../Progress';
import { formatCostSegmentIn, type CostSegment } from './cost-format';
import { useCostCurrency } from './CostCurrencyContext';

export interface CostSplitBarProps {
  readonly segments: readonly CostSegment[];
  /** What the bar measures, e.g. `Fix flaky checkout test cost` or `Cost in this entry`. */
  readonly label: string;
  /** The filled length, 0..1: the row's share of the scale maximum. Defaults to 1. */
  readonly scale?: number;
  /** `row` (h-1) under a list row, `summary` (h-1.5) for an entry or chat bar. */
  readonly size?: 'row' | 'summary';
  readonly testId?: string;
}

export function CostSplitBar({
  segments,
  label,
  scale = 1,
  size = 'row',
  testId,
}: CostSplitBarProps): JSX.Element {
  const currency = useCostCurrency();
  const visibleSegments = segments.filter((segment) => segment.value > 0);
  const visibleTotal = visibleSegments.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );
  const description = visibleSegments
    .map(
      (segment) => `${segment.label} ${formatCostSegmentIn(segment, currency)}`,
    )
    .join(', ');
  const boundedScale = Number.isNaN(scale)
    ? 0
    : Math.min(Math.max(scale, 0), 1);
  const filledScale = visibleTotal > 0 ? Math.max(boundedScale, 0.02) : 0;

  return (
    <SegmentsBar
      segments={visibleSegments}
      scale={filledScale}
      label={visibleTotal > 0 ? `${label}: ${description}` : `${label}: none`}
      size={size === 'summary' ? 'default' : 'compact'}
      dataTestId={testId}
    />
  );
}
