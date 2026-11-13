import type { JSX } from 'react';
import {
  SUBAGENT_REFERENCE_PREFIX,
  SUBAGENT_UNTITLED_LABEL,
} from '../subagent-copy';
import { SubagentIcon } from '../../../../icons/SubagentIcon';
import { REPLAY_BLOCK_CLASS } from '../../../../lib/replay-privacy';

export interface SubagentReferenceChipProps {
  readonly title: string;
  readonly className?: string;
}

/** The small, accessible robot chip attached to a message about a subagent. */
export function SubagentReferenceChip({
  title,
  className,
}: SubagentReferenceChipProps): JSX.Element {
  const visibleTitle = title || SUBAGENT_UNTITLED_LABEL;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md bg-subtle px-2 py-0.5 text-xs fg-secondary${className ? ` ${className}` : ''}`}
      data-testid="subagent-reference-chip"
    >
      <SubagentIcon size={12} />
      <span className="sr-only">{SUBAGENT_REFERENCE_PREFIX} </span>
      <span
        className={`${REPLAY_BLOCK_CLASS} min-w-0 truncate`}
        title={visibleTitle}
      >
        {visibleTitle}
      </span>
    </span>
  );
}
