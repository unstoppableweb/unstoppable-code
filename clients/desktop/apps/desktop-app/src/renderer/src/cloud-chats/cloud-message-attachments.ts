import { useMemo } from 'react';
import type { CloudChatUploadTarget } from '@canopy/desktop-shared/types';
import type { RemoteControlChatMessageAttachment } from '@canopy/protocol/remote-control/shell';
import { mediaTypeForAttachmentFilename } from '@canopy/protocol/cloud-attachments';
import type { ChatMessageAttachmentInteraction } from '@canopy/ui-app';
import { webCoreLocalId } from '@/lib/chat-authority';
import {
  cloudAttachmentIdOfPath,
  cloudAttachmentPath,
  isCloudAttachmentPath,
} from './cloud-chat-attachments';
import { loadCloudAttachmentThumbnail } from './cloud-attachment-thumbnails';

/**
 * A cloud chat message's attachments as the shared message media reads them
 * (CAN-6775). The store names each by its attachment path, which the send,
 * resend and queued-edit paths also read, so the path stays the one record
 * and this reads the id, name and media type back from it. Empty for a
 * message with no cloud attachment.
 */
export function cloudMessageAttachments(
  paths: readonly string[] | undefined,
): RemoteControlChatMessageAttachment[] {
  return (paths ?? []).flatMap((path) => {
    const attachmentId = cloudAttachmentIdOfPath(path);
    if (attachmentId === null) return [];
    const filename = path.slice(path.lastIndexOf('/') + 1);
    return [
      {
        attachmentId,
        // The thumbnail read names the attachment by its id.
        assetId: attachmentId,
        filename,
        mediaType:
          mediaTypeForAttachmentFilename(filename) ??
          'application/octet-stream',
      },
    ];
  });
}

/** Whether a message's attachments are a cloud chat's. */
export function hasCloudAttachments(
  paths: readonly string[] | undefined,
): boolean {
  return (paths ?? []).some(isCloudAttachmentPath);
}

/**
 * Saves a cloud chat's message attachment through that chat's own web core
 * read, never this computer's files (CAN-6775). A cancelled save dialog
 * resolves; any other failure rejects.
 */
export function cloudAttachmentDownload(
  target: CloudChatUploadTarget,
): (attachment: RemoteControlChatMessageAttachment) => Promise<void> {
  return async (attachment) => {
    const result = await window.api.cloudChats.downloadFile(target, {
      kind: 'attachment',
      id: attachment.attachmentId,
      filename: attachment.filename,
    });
    if (!result.ok && result.reason !== 'canceled')
      throw new Error(`Couldn't save ${attachment.filename}.`);
  };
}

/** A cloud chat's attachment thumbnails, read through that chat's web core. */
export function cloudAttachmentThumbnails(
  target: CloudChatUploadTarget,
): NonNullable<ChatMessageAttachmentInteraction['resolveImage']> {
  const chatId = webCoreLocalId(target.key);
  return async (reference) => {
    if (chatId === null) return null;
    const src = await loadCloudAttachmentThumbnail(
      window.canopyCore,
      chatId,
      cloudAttachmentPath(reference.assetId, reference.filename ?? ''),
    );
    return src === null ? null : { src };
  };
}

/**
 * How a cloud chat's message attachments save and show a thumbnail on
 * desktop, for the shared message media (CAN-6775). Desktop has no in-app
 * viewer for a cloud attachment, so it offers no Open: each tile reads
 * Download, as on a web host that can't open files, a failed save shows the
 * tile's own notice, and a cancelled save dialog says nothing. Null for a
 * local chat.
 */
export function useCloudChatAttachmentInteraction(
  target: CloudChatUploadTarget | null,
): ChatMessageAttachmentInteraction | null {
  return useMemo(
    () =>
      target === null
        ? null
        : {
            onDownload: cloudAttachmentDownload(target),
            imageSrc: () => null,
            resolveImage: cloudAttachmentThumbnails(target),
          },
    [target],
  );
}
