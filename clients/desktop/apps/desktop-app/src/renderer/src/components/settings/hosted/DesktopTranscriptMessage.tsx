import { useMemo, type JSX } from 'react';
import { ChatMessageView } from '@canopy/ui-app';
import type { MemoryTranscriptMessageProps } from '@canopy/ui-app/settings/memory/memory-settings-slots';
import { toDesktopTranscriptChatMessage } from './desktop-transcript-message';

/**
 * Memory source transcripts and organization transcript sessions render with
 * the shared chat message view on desktop, as web renders them with its chat
 * message renderer: user bubbles, assistant blocks and collapsed tool rows.
 * Loaded on demand, so settings pages without a transcript don't load it.
 */
export function DesktopTranscriptMessage({
  message,
}: MemoryTranscriptMessageProps): JSX.Element {
  const chatMessage = useMemo(
    () => toDesktopTranscriptChatMessage(message),
    [message],
  );
  return <ChatMessageView message={chatMessage} />;
}
