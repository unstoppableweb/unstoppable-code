import { formatCostDay } from '@canopy/ui-shared/components/cost';

/**
 * An amount with the day its data starts, when it doesn't cover the whole
 * entry or chat: `$0.0038 since Nov 13` (CAN-6668). A lower total never
 * appears without it.
 */
export function withCostCoverage(
  amountLabel: string,
  coverageStart: string | undefined,
): string {
  const day = coverageStart === undefined ? null : formatCostDay(coverageStart);
  return day === null ? amountLabel : `${amountLabel} since ${day}`;
}
