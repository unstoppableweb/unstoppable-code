// Rich hover/focus tooltip with a title line and a brief explanation, matching
// the badge tooltips on the pipeline list page. Wraps a single interactive
// element and delegates positioning to RichHoverTooltip.
import { type JSX, type ReactElement, type ReactNode } from 'react';
import { RichHoverTooltip, type TooltipTriggerProps } from './RichHoverTooltip';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

const DESCRIPTION_CLASS = 'mt-0.5 text-3xs leading-snug fg-secondary';

export interface ActionTooltipProps {
  /** Bold first line. */
  title: string;
  /**
   * Muted explanatory line under the title. A node, so a caller can mask one
   * user-authored value in it (a chat title) for session replay.
   */
  description: ReactNode;
  /** The trigger element — must accept `className` and `aria-describedby`. */
  children: ReactElement<{ className?: string } & TooltipTriggerProps>;
  /** Suppress the tooltip for states that need no explanation. */
  disabled?: boolean;
  /**
   * Mark the description with the session-replay block class; the title
   * stays recorded. Set it when the description carries conversation content
   * (an automation's prompt): the tooltip portals to `document.body`, out of
   * its trigger's block.
   */
  blockDescriptionFromReplay?: boolean;
}

export function ActionTooltip({
  title,
  description,
  children,
  disabled = false,
  blockDescriptionFromReplay = false,
}: ActionTooltipProps): JSX.Element {
  return (
    <RichHoverTooltip
      disabled={disabled}
      surfaceClassName="w-max max-w-56"
      surfacePadding="relaxed"
      content={
        <span className="flex flex-col items-center text-center">
          <span className="text-2xs font-medium leading-tight fg-primary">
            {title}
          </span>
          <span
            className={
              blockDescriptionFromReplay
                ? `${REPLAY_BLOCK_CLASS} ${DESCRIPTION_CLASS}`
                : DESCRIPTION_CLASS
            }
          >
            {description}
          </span>
        </span>
      }
    >
      {children}
    </RichHoverTooltip>
  );
}
