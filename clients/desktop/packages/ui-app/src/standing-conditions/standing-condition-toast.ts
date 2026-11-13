import type { AppError } from '@canopy/protocol/app-errors';
import {
  standingConditionCountLabel,
  standingConditionTitle,
  visibleStandingConditions,
  type StandingCondition,
  type StandingConditionAction,
} from './standing-conditions';

/**
 * The top standing condition as a pinned card in the host's toast stack
 * (CAN-6361): the stack every host already has for conditions it reports
 * until they clear or are closed, so standing conditions add no surface of
 * their own. Hosts map it onto their pinned-toast input.
 */
export interface StandingConditionToast {
  /** Stable per condition, so an update replaces the card in place. */
  readonly id: string;
  /** A defect is an error card; every other condition a warning. */
  readonly type: 'error' | 'warning';
  readonly title: string;
  readonly message: string;
  /** How many more conditions are active, kept below the message. */
  readonly messageContext?: string;
  readonly action?: StandingConditionAction;
  /** The episode's recorded error; a defect's card shows its reference. */
  readonly error: AppError;
}

/**
 * The card for the highest-ranked visible condition, or null when none shows
 * or the person closed this episode (`closedReference`). A closed card stays
 * closed until a different condition or a new episode comes to the top.
 */
export function standingConditionToast(
  conditions: readonly StandingCondition[],
  closedReference: string | null,
): StandingConditionToast | null {
  const [top, ...remaining] = visibleStandingConditions(conditions);
  if (!top || top.error.referenceId === closedReference) return null;
  return {
    id: `standing-condition-${top.id}`,
    type: top.error.kind === 'defect' ? 'error' : 'warning',
    title: standingConditionTitle(top),
    // Every standing condition's catalog copy has a description.
    message: top.error.copy.description ?? '',
    ...(remaining.length > 0
      ? { messageContext: standingConditionCountLabel(remaining.length) }
      : {}),
    ...(top.action === undefined ? {} : { action: top.action }),
    error: top.error,
  };
}
