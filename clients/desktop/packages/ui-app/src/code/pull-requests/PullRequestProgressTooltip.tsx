'use client';

import type { JSX, ReactElement } from 'react';
import {
  ProgressChecklist,
  HoverCard,
  type ProgressChecklistBadge,
  type ProgressChecklistStep,
  type HoverCardTriggerProps,
} from '@canopy/ui-shared/components';

/**
 * The checklist a running header action shows on hover (REG-3025): its steps,
 * the failure that stopped it, and a badge. Hosts build it from their own
 * progress state; the tooltip is the same on every host.
 */
export interface PullRequestProgressModel {
  readonly steps: ProgressChecklistStep[];
  readonly error?: string;
  readonly badge: ProgressChecklistBadge;
}

/** Commit-and-push phase copy, shared by every host's checklist. */
export const COMMIT_PUSH_PHASE_LABELS = {
  pulling: 'Pulling',
  generating_message: 'Generating message',
  staging: 'Staging',
  committing: 'Committing',
  pushing: 'Pushing',
  done: 'Done',
  error: 'Error',
} as const;

export interface PullRequestProgressTooltipProps {
  /** `null` while the action is idle: the wrapper stays, silent. */
  readonly model: PullRequestProgressModel | null;
  /**
   * Keeps the wrapper mounted but never shows the checklist, for an action
   * whose steps do not describe what the click will do.
   */
  readonly suppressed?: boolean;
  readonly dataTestId?: string;
  /** The raw action button: the wrapper clones trigger props onto it. */
  readonly children: ReactElement<HoverCardTriggerProps>;
}

/**
 * Wraps a header action button and, while that action is in progress (or
 * after it errors), shows a portaled checklist of the action's steps.
 */
export function PullRequestProgressTooltip({
  model,
  suppressed = false,
  dataTestId,
  children,
}: PullRequestProgressTooltipProps): JSX.Element {
  return (
    <HoverCard
      disabled={suppressed || model === null}
      dataTestId={dataTestId}
      content={
        model ? (
          <ProgressChecklist
            steps={model.steps}
            error={model.error}
            badge={model.badge}
          />
        ) : null
      }
    >
      {children}
    </HoverCard>
  );
}
