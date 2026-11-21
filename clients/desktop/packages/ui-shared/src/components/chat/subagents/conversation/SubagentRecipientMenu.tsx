'use client';

import type { RefObject, JSX } from 'react';
import type { SubagentRecipient } from '@canopy/agent-transcript';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuSectionLabel,
} from '../../../PickerMenu';
import { ChatIcon } from '../../../../icons/AppIcons';
import { SubagentIcon } from '../../../../icons/SubagentIcon';
import {
  SUBAGENT_COMPOSER_NATIVE_NOTICE,
  SUBAGENT_COMPOSER_READ_ONLY_NOTICE,
  SUBAGENT_COMPOSER_TO_MENU_LABEL,
  subagentRecipientRelationLabel,
  subagentRootChatStateLabel,
  subagentStatusLabel,
} from '../subagent-copy';
import { SUBAGENT_RECIPIENT_CANNOT_MESSAGE_LABEL } from './conversation-copy';

export interface SubagentRecipientMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly recipients: readonly SubagentRecipient[];
  readonly selectedId: string;
  readonly rootBusy: boolean;
  readonly onSelect: (recipient: SubagentRecipient) => void;
  readonly canSelect?: (recipient: SubagentRecipient) => boolean;
  readonly disabledReason?: (
    recipient: SubagentRecipient,
  ) => string | undefined;
}

function recipientStatus(
  recipient: SubagentRecipient,
  rootBusy: boolean,
): string {
  if (recipient.kind === 'root') return subagentRootChatStateLabel(rootBusy);
  return subagentStatusLabel(recipient.status ?? 'idle');
}

function recipientUnavailableReason(
  recipient: SubagentRecipient,
  canSelect: boolean,
  disabledReason:
    | ((recipient: SubagentRecipient) => string | undefined)
    | undefined,
): string | undefined {
  const customReason = disabledReason?.(recipient);
  if (customReason) return customReason;
  if (!recipient.canMessage) {
    return recipient.kind === 'self'
      ? SUBAGENT_COMPOSER_NATIVE_NOTICE
      : SUBAGENT_RECIPIENT_CANNOT_MESSAGE_LABEL;
  }
  return canSelect ? undefined : SUBAGENT_COMPOSER_READ_ONLY_NOTICE;
}

/** The option list used by the To picker. */
export function SubagentRecipientMenu({
  open,
  onOpenChange,
  anchorRef,
  recipients,
  selectedId,
  rootBusy,
  onSelect,
  canSelect,
  disabledReason,
}: SubagentRecipientMenuProps): JSX.Element | null {
  if (!open) return null;
  return (
    <FloatingPickerMenu
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      placement="top-left"
      heightLimit={280}
      interaction="menu"
      aria-label={SUBAGENT_COMPOSER_TO_MENU_LABEL}
      data-testid="subagent-composer-to-menu"
    >
      <div className="flex flex-col py-1">
        <PickerMenuSectionLabel>
          {SUBAGENT_COMPOSER_TO_MENU_LABEL}
        </PickerMenuSectionLabel>
        {recipients.map((recipient) => {
          const allowed = canSelect?.(recipient) ?? recipient.canMessage;
          const reason = recipientUnavailableReason(
            recipient,
            allowed,
            disabledReason,
          );
          const selected = recipient.id === selectedId;
          return (
            <PickerMenuOption
              key={recipient.id}
              role="menuitemradio"
              aria-checked={selected}
              disabled={!allowed}
              selected={selected}
              onClick={(): void => {
                if (!allowed) return;
                onSelect(recipient);
                onOpenChange(false);
              }}
              data-testid={`subagent-composer-to-option-${recipient.id}`}
              title={reason}
            >
              <PickerMenuOptionLeading
                tone={recipient.kind === 'root' ? 'secondary' : 'accent'}
              >
                {recipient.kind === 'root' ? (
                  <ChatIcon size={14} aria-hidden />
                ) : (
                  <SubagentIcon size={14} />
                )}
              </PickerMenuOptionLeading>
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>{recipient.title}</PickerMenuOptionLabel>
                <PickerMenuOptionDescription>
                  {subagentRecipientRelationLabel(recipient)} ·{' '}
                  {recipientStatus(recipient, rootBusy)}
                  {reason ? ` · ${reason}` : ''}
                </PickerMenuOptionDescription>
              </PickerMenuOptionContent>
              <PickerMenuOptionCheck selected={selected} />
            </PickerMenuOption>
          );
        })}
      </div>
    </FloatingPickerMenu>
  );
}
