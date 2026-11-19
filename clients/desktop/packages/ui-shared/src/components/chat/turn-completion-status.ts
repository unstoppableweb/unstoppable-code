import type { TurnOutcomeCounts } from '@canopy/protocol/remote-control/shell';

/**
 * How a settled turn ended, as its footer and clean header say it:
 * "Completed in …", "Failed after …", "Stopped after …" or
 * "Interrupted after …".
 */
export type TurnCompletionStatus =
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** A turn end that is not the plain complete one. */
export type TurnTerminalStatus = Exclude<TurnCompletionStatus, 'complete'>;

export interface TurnCompletionEvidence {
  /** Whether the turn has ended. A running turn has no terminal status. */
  readonly settled: boolean;
  /**
   * The end the host recorded for the turn: a failure or cancellation, or
   * interruption evidence (the turn was cut off by a restart, or its
   * projected timer says so). Omit when nothing was recorded.
   */
  readonly recorded?: TurnTerminalStatus;
  /** The turn's step outcomes; an interrupted step interrupts the turn. */
  readonly outcomes?: TurnOutcomeCounts;
}

/**
 * The one place a turn's completion is decided, so its summary, header and
 * footer never disagree. While running there is none. Once settled, a
 * recorded failure or cancellation wins, then recorded interruption
 * evidence, then any interrupted step; otherwise the turn completed. Step
 * errors alone never fail the turn: counts describe tools, this the turn.
 */
export function resolveTurnCompletionStatus({
  settled,
  recorded,
  outcomes,
}: TurnCompletionEvidence): TurnCompletionStatus | undefined {
  if (!settled) return undefined;
  if (recorded === 'failed' || recorded === 'cancelled') return recorded;
  if (recorded === 'interrupted') return 'interrupted';
  if ((outcomes?.interrupted ?? 0) > 0) return 'interrupted';
  return 'complete';
}
