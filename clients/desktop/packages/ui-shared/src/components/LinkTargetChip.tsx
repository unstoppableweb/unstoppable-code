import type { JSX } from 'react';

import { BranchIcon, WarningIcon } from '../icons/AppIcons';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { Tooltip } from '../primitives/Tooltip';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/**
 * Where a pasted link would send the draft. Hosts decide the state; this
 * component only displays it.
 */
export type LinkTargetChipStatus =
  | 'resolving'
  | 'ready'
  | 'blocked'
  | 'submitting';

export interface LinkTargetChipAction {
  /** Stable id, used for the action's test id. */
  id: string;
  label: string;
  onSelect: () => void;
}

export interface LinkTargetChipProps {
  status: LinkTargetChipStatus;
  /** One short sentence naming the destination or the blocker. */
  label: string;
  /** Optional secondary line, such as a disclosed side effect. */
  detail?: string;
  actions?: readonly LinkTargetChipAction[];
  /** Omit to hide the dismiss control (for example while submitting). */
  onDismiss?: () => void;
  dismissLabel?: string;
  'data-testid'?: string;
}

/**
 * Displays the worktree destination proposed for a link in a draft, as a
 * `Chip` (status icon, label, dismiss) followed by its actions, with the
 * optional detail on its own line below. `Chip` has no busy state: while the
 * link resolves or submits, the label says so and is marked `aria-busy`.
 * Pure display: resolution, project policy, and context changes stay in the
 * host.
 */
export function LinkTargetChip({
  status,
  label,
  detail,
  actions = [],
  onDismiss,
  dismissLabel = 'Don’t use this link for a worktree',
  'data-testid': testId = 'link-target-chip',
}: LinkTargetChipProps): JSX.Element {
  const busy = status === 'resolving' || status === 'submitting';
  return (
    <div
      data-testid={testId}
      data-status={status}
      role="group"
      aria-label="Link destination"
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-xs pointer-coarse:gap-x-4 pointer-coarse:gap-y-4"
    >
      {/* The label truncates on one line; the tooltip, on touch too, holds
          all of it. */}
      <Tooltip
        label={<span className={REPLAY_MASK_CLASS}>{label}</span>}
        className="max-w-full"
        showOnTouch
      >
        <Chip
          icon={
            status === 'blocked'
              ? WarningIcon
              : status === 'resolving'
                ? undefined
                : BranchIcon
          }
          onRemove={onDismiss}
          removeLabel={dismissLabel}
          removeTestId={`${testId}-dismiss`}
        >
          <span
            role="status"
            aria-live="polite"
            aria-busy={busy}
            data-testid={`${testId}-label`}
            // The label can name the user's project, so replays mask it.
            // Without a dismiss button nothing in the chip takes focus, so
            // the label does, to open the tooltip from the keyboard; its ring
            // sits inside, since the chip clips its text.
            tabIndex={onDismiss ? undefined : 0}
            className={`${REPLAY_MASK_CLASS}${onDismiss ? '' : ' focus-ring focus-ring-inset rounded-sm'}`}
          >
            {label}
            {/* The detail is drawn on its own line below, so the live region
                carries it here to announce it with the destination. */}
            {detail && <span className="sr-only">. {detail}</span>}
          </span>
        </Chip>
      </Tooltip>
      {actions.map((action) => (
        <Button
          variant="secondary"
          size="compact"
          key={action.id}
          data-testid={`${testId}-action-${action.id}`}
          onClick={action.onSelect}
        >
          {action.label}
        </Button>
      ))}
      {detail && (
        <span
          data-testid={`${testId}-detail`}
          aria-hidden
          className={`${REPLAY_MASK_CLASS} min-w-0 basis-full break-words text-pretty fg-secondary`}
        >
          {detail}
        </span>
      )}
    </div>
  );
}
