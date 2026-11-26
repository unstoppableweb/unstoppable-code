import type { JSX } from 'react';
import { HeaderActionButton } from '../../../HeaderActionButton';
import { Button } from '../../../../primitives/Button';
import { SubagentIcon } from '../../../../icons/SubagentIcon';

export const SUBAGENT_VIEW_TREE_LABEL = 'View tree';

export interface SubagentViewTreeActionProps {
  readonly onClick: () => void;
  readonly dataTestId?: string;
  readonly appearance?: 'default' | 'section';
}

/** Shared chat-header action for opening the current chat's subagent tree. */
export function SubagentViewTreeAction({
  onClick,
  dataTestId = 'agent-activity-view-tree',
  appearance = 'default',
}: SubagentViewTreeActionProps): JSX.Element {
  if (appearance === 'section') {
    return (
      <Button
        variant="ghost"
        size="compact"
        data-testid={dataTestId}
        onClick={onClick}
      >
        {SUBAGENT_VIEW_TREE_LABEL}
      </Button>
    );
  }
  return (
    <HeaderActionButton
      tone="neutral"
      data-testid={dataTestId}
      onClick={onClick}
    >
      <SubagentIcon size={14} />
      {SUBAGENT_VIEW_TREE_LABEL}
    </HeaderActionButton>
  );
}
