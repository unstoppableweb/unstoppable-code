'use client';

import { useRef, useState, type JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import {
  Button,
  ErrorBanner,
  useAgentVisualHostTheme,
} from '@canopy/ui-shared/components';
import {
  CHAT_VISUAL_TEST_IDS,
  useChatVisualHost,
  type ChatVisualOwner,
} from './chat-visual-host';
import { useChatVisualDocument } from './ChatVisualBlock';
import { ChatVisualDialog } from './ChatVisualDialog';

export interface ChatVisualSourceButtonProps {
  owner: ChatVisualOwner;
  /** Placement within the host's layout. */
  className?: string;
}

export function ChatVisualSourceButton({
  owner,
  className = '',
}: ChatVisualSourceButtonProps): JSX.Element | null {
  const capabilities = useCapabilities();
  const host = useChatVisualHost();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const enabled = capabilities.chatVisuals === true && host !== null;
  const { document, error, loading } = useChatVisualDocument(
    owner,
    host,
    enabled && open,
  );
  const theme = useAgentVisualHostTheme();
  if (!enabled) return null;
  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      <Button
        ref={buttonRef}
        type="button"
        variant="secondary"
        size="sm"
        data-testid={CHAT_VISUAL_TEST_IDS.sourceButton}
        onClick={(): void => setOpen(true)}
      >
        View source
      </Button>
      {open && loading ? (
        <p role="status" className="text-xs fg-secondary">
          Loading visual source…
        </p>
      ) : null}
      {open && error ? (
        <ErrorBanner
          errorSource="chat-visual-source-button"
          className=""
          error="Couldn't load this visual. Try again later."
        />
      ) : null}
      {open && document !== undefined ? (
        <ChatVisualDialog
          owner={owner}
          document={document}
          host={host}
          theme={theme}
          initialTab="source"
          ownerDocument={buttonRef.current?.ownerDocument}
          onClose={(): void => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
