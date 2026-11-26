import type { JSX } from 'react';
import { ChatIcon, PipelineIcon } from '../icons/AppIcons';
import { Button } from '../primitives/Button';
import { Tooltip } from '../primitives/Tooltip';

export interface PlanOpenImplementationActionProps {
  /** Where the selected attempt runs: a chat turn or a workflow run. */
  venue: 'chat' | 'pipeline';
  onOpen: () => void;
  /** Icon-only, keeping the accessible name and showing it as a tooltip. */
  compact?: boolean;
  /** Emphasis follows the plan's review state, like Execute. */
  emphasis?: 'primary' | 'secondary';
  /** Prefix for the `<prefix>-open` test id. */
  dataTestIdPrefix: string;
}

/**
 * Open, which replaces Execute while a plan's selected implementation
 * attempt runs and after it succeeds. Pure display: the host resolves the
 * attempt with `resolvePlanDisplayStatus` and navigates to exactly that chat
 * or run.
 */
export function PlanOpenImplementationAction({
  venue,
  onOpen,
  compact = false,
  emphasis = 'secondary',
  dataTestIdPrefix,
}: PlanOpenImplementationActionProps): JSX.Element {
  const accessibleName = venue === 'chat' ? 'Open chat' : 'Open run';
  const Icon = venue === 'chat' ? ChatIcon : PipelineIcon;
  return (
    <Tooltip label={accessibleName} suppressed={!compact}>
      {compact ? (
        <Button
          size="compact"
          variant={emphasis}
          iconOnly
          aria-label={accessibleName}
          onClick={onOpen}
          data-testid={`${dataTestIdPrefix}-open`}
        >
          <Icon size="md" aria-hidden />
        </Button>
      ) : (
        <Button
          size="compact"
          variant={emphasis}
          aria-label={accessibleName}
          onClick={onOpen}
          data-testid={`${dataTestIdPrefix}-open`}
        >
          <Icon size="md" aria-hidden />
          Open
        </Button>
      )}
    </Tooltip>
  );
}
