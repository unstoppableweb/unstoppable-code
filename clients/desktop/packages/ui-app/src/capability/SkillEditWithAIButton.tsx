'use client';

import { type JSX, useId } from 'react';
import { Tooltip, Button } from '@canopy/ui-shared/components';
import { SparkleIcon } from '@canopy/ui-shared/icons/AppIcons';

/** The action's visible label (CAN-1259). */
export const EDIT_WITH_AI_LABEL = 'Edit with AI';
/** Title of the unavailable action's tooltip. */
const EDIT_WITH_AI_UNAVAILABLE_TITLE = 'Edit with AI unavailable';

/**
 * Whether "Edit with AI" can start for a skill. An unavailable action stays
 * visible and focusable with the reason and next step, so read-only skills
 * explain themselves instead of silently lacking the action.
 */
export type SkillEditWithAIState =
  | {
      available: true;
      onSelect: () => void;
      /** The host is opening the chat; the action ignores further presses. */
      pending?: boolean;
    }
  | {
      available: false;
      /** Why the skill cannot be edited here, with the next step. */
      reason: string;
    };

export interface SkillEditWithAIButtonProps {
  state: SkillEditWithAIState;
  dataTestId: string;
}

/** Matches the secondary actions it sits beside on both pages. */

/**
 * The "Edit with AI" action shared by the installed skill detail and its edit
 * page. Inert states use `aria-disabled` rather than `disabled` so keyboard
 * users can still reach the control and hear why it is unavailable.
 */
export function SkillEditWithAIButton({
  state,
  dataTestId,
}: SkillEditWithAIButtonProps): JSX.Element {
  const reasonId = useId();
  const pending = state.available && state.pending === true;
  const inert = !state.available || pending;
  const button = (
    <Button
      type="button"
      size="compact"
      onClick={() => {
        if (state.available && !pending) state.onSelect();
      }}
      aria-disabled={inert || undefined}
      aria-busy={pending || undefined}
      aria-describedby={state.available ? undefined : reasonId}
      data-testid={dataTestId}
    >
      <SparkleIcon size="sm" aria-hidden />
      {EDIT_WITH_AI_LABEL}
    </Button>
  );
  if (state.available) return button;
  return (
    <>
      <Tooltip
        label={EDIT_WITH_AI_UNAVAILABLE_TITLE}
        description={state.reason}
      >
        {button}
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {state.reason}
      </span>
    </>
  );
}
