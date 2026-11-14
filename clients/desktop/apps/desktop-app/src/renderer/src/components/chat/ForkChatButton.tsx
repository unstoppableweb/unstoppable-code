import type { JSX } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ForkChatButton as SharedForkChatButton } from '@canopy/ui-shared';

export interface ForkChatButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function ForkChatButton({
  onClick,
  disabled = false,
}: ForkChatButtonProps): JSX.Element {
  return (
    <SharedForkChatButton
      ariaLabel={`Fork ${CHAT_UNIT_LABEL.toLowerCase()}`}
      dataTestId="fork-chat-button"
      onClick={onClick}
      disabled={disabled}
    />
  );
}
