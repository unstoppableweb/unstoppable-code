'use client';

import type { JSX, Ref } from 'react';
import type { SubagentRecipient } from '@canopy/agent-transcript';
import {
  PickerTrigger,
  PickerTriggerChevron,
} from '../../../../primitives/PickerMenu';
import { ChatIcon } from '../../../../icons/AppIcons';
import { SubagentIcon } from '../../../../icons/SubagentIcon';
import {
  SUBAGENT_COMPOSER_TO_LABEL,
  subagentComposerToAccessibleLabel,
} from '../subagent-copy';

export interface SubagentRecipientTriggerProps {
  readonly recipient: SubagentRecipient;
  readonly open: boolean;
  readonly onClick: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}

/** The compact To capsule in the subagent composer. */
export function SubagentRecipientTrigger({
  recipient,
  open,
  onClick,
  buttonRef,
}: SubagentRecipientTriggerProps): JSX.Element {
  return (
    <PickerTrigger
      ref={buttonRef}
      variant="capsule"
      aria-label={subagentComposerToAccessibleLabel(recipient.title)}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid="subagent-composer-to"
      onClick={onClick}
      className="min-w-0 max-w-72"
    >
      {recipient.kind === 'root' ? (
        <ChatIcon size={14} aria-hidden />
      ) : (
        <SubagentIcon size={14} />
      )}
      <span className="shrink-0 fg-tertiary">{SUBAGENT_COMPOSER_TO_LABEL}</span>
      <span className="min-w-0 truncate">{recipient.title}</span>
      <PickerTriggerChevron open={open} />
    </PickerTrigger>
  );
}
