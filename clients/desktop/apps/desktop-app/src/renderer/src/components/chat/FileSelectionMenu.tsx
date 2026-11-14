import { useEffect, useRef, type JSX } from 'react';
import { ChatIcon, MessageIcon } from '@canopy/ui-shared/icons';
import { SelectionActionPill } from '@canopy/ui-shared/components';

interface FileSelectionMenuProps {
  anchorRect: DOMRect;
  onSendToChat: () => void;
  onCopy: () => boolean | Promise<boolean>;
  onComment: () => void;
  onClose: () => void;
}

/**
 * Compact action pill shown after selecting text in Monaco: the shared
 * selection pill the terminal also draws, with the file-specific option to
 * turn the selection into a comment thread.
 */
export function FileSelectionMenu({
  anchorRect,
  onSendToChat,
  onCopy,
  onComment,
  onClose,
}: FileSelectionMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (event: globalThis.MouseEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        onClose();
      }
    };
    const handleKeyDown = (): void => {
      onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    // Monaco consumes several editing shortcuts before they bubble. Capture
    // keyboard input first so any attempt to resume typing dismisses the
    // selection pill without interfering with the editor's own command.
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  return (
    <SelectionActionPill
      ref={menuRef}
      placement={{ kind: 'window', rect: anchorRect, ownerDocument: document }}
      role="menu"
      aria-label="Selected file text actions"
      data-testid="file-selection-menu"
      actions={[
        {
          key: 'send-to-chat',
          label: 'Send to chat',
          tooltip: 'Send the selected file text to the chat composer',
          icon: <ChatIcon aria-hidden="true" />,
          testId: 'file-selection-send-to-chat',
          onSelect: onSendToChat,
        },
        {
          key: 'copy',
          tooltip: 'Copy the selected file text',
          testId: 'file-selection-copy',
          onCopy,
        },
        {
          key: 'comment',
          label: 'Comment',
          tooltip: 'Comment on the selected file text',
          icon: <MessageIcon aria-hidden="true" />,
          testId: 'file-selection-comment',
          onSelect: onComment,
        },
      ]}
    />
  );
}
