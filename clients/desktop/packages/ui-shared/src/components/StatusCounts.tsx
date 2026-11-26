import type { JSX } from 'react';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from '../primitives/SegmentedControl';

export interface StatusCountItem<TStatus extends string> {
  readonly status: TStatus;
  readonly label: string;
  readonly count: number;
}

export interface StatusCountsProps<TStatus extends string> {
  /** In display order; items with count 0 are left out unless selected. */
  readonly items: readonly StatusCountItem<TStatus>[];
  /** The All count. */
  readonly total: number;
  /** `null` is All. */
  readonly selected: TStatus | null;
  readonly onSelect: (status: TStatus | null) => void;
  /** Label for the All filter. Defaults to `All`. */
  readonly allLabel?: string;
  /** Accessible name for the filter group. Defaults to `Filter by status`. */
  readonly ariaLabel?: string;
  /** Applied to the filter group. */
  readonly testId?: string;
}

/** The All filter's segment value; a status never takes it. */
const ALL_VALUE = 'all';

/**
 * A row of status filters, one at a time: All, then each status with its
 * count. Pure display: the caller owns the selected status and decides how it
 * filters the list. Each segment's test id is the group's, then its status
 * (`…-all` for All).
 */
export function StatusCounts<TStatus extends string>({
  items,
  total,
  selected,
  onSelect,
  allLabel = 'All',
  ariaLabel = 'Filter by status',
  testId,
}: StatusCountsProps<TStatus>): JSX.Element {
  const count = (value: number): JSX.Element => (
    <span className="tabular-nums fg-tertiary">{value}</span>
  );
  const options: SegmentedControlOption<TStatus | typeof ALL_VALUE>[] = [
    {
      value: ALL_VALUE,
      label: allLabel,
      trailing: count(total),
      ...(testId === undefined ? {} : { dataTestId: `${testId}-all` }),
    },
    ...items
      .filter((item) => item.count > 0 || item.status === selected)
      .map((item) => ({
        value: item.status,
        label: item.label,
        trailing: count(item.count),
        ...(testId === undefined
          ? {}
          : { dataTestId: `${testId}-${item.status}` }),
      })),
  ];
  return (
    <SegmentedControl<TStatus | typeof ALL_VALUE>
      value={selected ?? ALL_VALUE}
      options={options}
      onChange={(next): void => onSelect(next === ALL_VALUE ? null : next)}
      label={ariaLabel}
      width="content"
      {...(testId === undefined ? {} : { dataTestId: testId })}
    />
  );
}
