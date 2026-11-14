'use client';

import type { JSX } from 'react';
import { ChatIcon } from '@canopy/ui-shared/icons';
import { SelectionActionPill } from '@canopy/ui-shared/components';

interface TerminalSelectionMenuProps {
  /** Pixel offset from the host container's top edge. */
  top: number;
  /** Pixel offset from the host container's left edge. */
  left: number;
  onCopy: () => boolean | Promise<boolean>;
  onAddToChat?: () => void;
}

const PLATFORM_MOD_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘L'
    : 'Ctrl+L';

export function TerminalSelectionMenu({
  top,
  left,
  onCopy,
  onAddToChat,
}: TerminalSelectionMenuProps): JSX.Element {
  return (
    <SelectionActionPill
      placement={{ kind: 'pane', top, left }}
      actions={[
        {
          key: 'copy',
          tooltip: 'Copy the selected terminal text',
          testId: 'terminal-selection-copy',
          onCopy,
        },
        ...(onAddToChat
          ? [
              {
                key: 'add-to-chat',
                label: 'Send to chat',
                tooltip: 'Send the selected terminal text to the chat composer',
                icon: <ChatIcon aria-hidden="true" />,
                shortcut: PLATFORM_MOD_LABEL,
                testId: 'terminal-selection-add-to-chat',
                onSelect: onAddToChat,
              },
            ]
          : []),
      ]}
    />
  );
}
