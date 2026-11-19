import { Fragment, type JSX } from 'react';
import type { TurnOutcomeCounts } from '@canopy/protocol/remote-control/shell';
import {
  formatTurnOutcomeLabel,
  turnOutcomeEntries,
} from './turn-outcome-label';

/**
 * "· 1 blocked · 2 errors · 1 interrupted": how a run of steps went, the one
 * rendering behind a step group's line and a finished turn's header. Plain
 * inline words in the surrounding size and ink, so a narrow step row can
 * truncate them. Renders no counts for all zeros; callers check first.
 */
export function TurnOutcomeWords({
  outcomes,
  leadingSeparator = true,
  entryTestIdPrefix,
}: {
  outcomes: TurnOutcomeCounts;
  /** Start with a `·`, for words that follow other words. */
  leadingSeparator?: boolean;
  /** Tags each count `<prefix>-blocked`, `-failed` or `-interrupted`. */
  entryTestIdPrefix?: string;
}): JSX.Element {
  return (
    <span data-turn-outcome-words="">
      {turnOutcomeEntries(outcomes).map((entry, index) => (
        <Fragment key={entry.key}>
          {index > 0 && ' '}
          <span
            data-turn-outcome={entry.key}
            data-testid={
              entryTestIdPrefix === undefined
                ? undefined
                : `${entryTestIdPrefix}-${entry.key}`
            }
          >
            {(index > 0 || leadingSeparator) && (
              <>
                <span aria-hidden="true">·</span>{' '}
              </>
            )}
            {formatTurnOutcomeLabel(entry.key, entry.count)}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
