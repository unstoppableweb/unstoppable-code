import { useEffect, useRef, useState, type JSX } from 'react';
import { RefreshButton } from '../RefreshButton';
import { Tooltip } from '../Tooltip';
import { formatCostDay, formatCostUpdated } from './cost-format';

export interface CostFreshnessProps {
  /** When the figures last caught up (ISO). Null: no time is shown. */
  readonly updatedAt: string | null;
  /** Now in ms, for relative time; defaults to Date.now() at render. */
  readonly now?: number;
  /** A refresh is running: the button spins; the time stays. */
  readonly refreshing?: boolean;
  /** The last refresh failed: the time reads `Couldn't refresh` (warning ink) with this reason in a Tooltip. */
  readonly failureReason?: string | null;
  /** A sealed (retained) entry: shows `Final as of Oct 6` (formatCostDay) and no refresh button. */
  readonly sealedAt?: string;
  /** Omit to hide the button. */
  readonly onRefresh?: () => void;
  /** Count of successful manual refreshes; every increase after mount announces `Cost updated` through a polite status (role="status" aria-live="polite", sr-only), not a live region on the visible text. */
  readonly completedRefreshes?: number;
  readonly testId?: string;
}

export function CostFreshness({
  updatedAt,
  now,
  refreshing = false,
  failureReason,
  sealedAt,
  onRefresh,
  completedRefreshes = 0,
  testId = 'cost-freshness',
}: CostFreshnessProps): JSX.Element {
  const [announcedRefresh, setAnnouncedRefresh] = useState<number | null>(null);
  const previousRefreshCount = useRef(completedRefreshes);

  useEffect(() => {
    if (completedRefreshes > previousRefreshCount.current) {
      setAnnouncedRefresh(completedRefreshes);
    }
    previousRefreshCount.current = completedRefreshes;
  }, [completedRefreshes]);

  let label: string | null;
  if (sealedAt !== undefined) {
    label = `Final as of ${formatCostDay(sealedAt) ?? sealedAt}`;
  } else if (failureReason !== undefined && failureReason !== null) {
    label = "Couldn't refresh";
  } else {
    label = formatCostUpdated(updatedAt, now ?? Date.now());
  }

  return (
    <div
      data-testid={testId}
      className="flex shrink-0 items-center gap-1 text-xs fg-tertiary"
    >
      {label !== null ? (
        failureReason !== undefined &&
        failureReason !== null &&
        sealedAt === undefined ? (
          <Tooltip label={failureReason} clamp={false}>
            <span
              data-testid={`${testId}-label`}
              className="text-xs fg-warning"
            >
              {label}
            </span>
          </Tooltip>
        ) : (
          <span data-testid={`${testId}-label`} className="text-xs fg-tertiary">
            {label}
          </span>
        )
      ) : null}
      {sealedAt === undefined && onRefresh !== undefined ? (
        <RefreshButton
          ariaLabel="Refresh cost"
          busy={refreshing}
          dataTestId="cost-refresh"
          onClick={onRefresh}
        />
      ) : null}
      {announcedRefresh !== null ? (
        <span
          key={announcedRefresh}
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          Cost updated
        </span>
      ) : null}
    </div>
  );
}
