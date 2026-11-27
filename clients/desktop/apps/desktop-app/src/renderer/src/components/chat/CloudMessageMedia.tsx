import { useMemo, type JSX } from 'react';
import {
  ChatMessageMedia,
  useChatMessageAttachmentSplit,
} from '@canopy/ui-app';
import { cloudMessageAttachments } from '@/cloud-chats/cloud-message-attachments';

/**
 * A cloud chat message's attachments in the shared message media the web
 * mounts (CAN-6775); the chat's attachment interaction decides what a tile
 * does. A local message's attachments stay in `MessageImages`.
 */
export function CloudMessageMedia({
  attachmentPaths,
  alone = false,
}: {
  readonly attachmentPaths: readonly string[];
  /** The message has no text under the row. */
  readonly alone?: boolean;
}): JSX.Element | null {
  const attachments = useMemo(
    () => cloudMessageAttachments(attachmentPaths),
    [attachmentPaths],
  );
  const { media, onMediaFailed } = useChatMessageAttachmentSplit(attachments);
  return (
    <ChatMessageMedia
      media={media}
      onMediaFailed={onMediaFailed}
      alone={alone}
    />
  );
}
