import type { JSX } from 'react';

/**
 * The line under a prompt whose turn was cancelled before it ran, such as a
 * prompt deleted from a chat's queue. It sits inside the prompt's
 * `UserBubble`, on the web and on desktop alike. Its gap is padding, not a
 * margin: the prompt's last paragraph keeps its own 2px margin, so the two
 * add up to the 4px gap the line always had.
 */
export function UserBubbleCancelledNote(): JSX.Element {
  return (
    <div className="pt-0.5 text-xs fg-secondary">
      <span>Cancelled</span>
    </div>
  );
}
