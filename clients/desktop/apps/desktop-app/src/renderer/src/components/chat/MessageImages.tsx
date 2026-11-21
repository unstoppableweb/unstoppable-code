import { useCallback, useContext, useMemo, type JSX } from 'react';
import {
  MessageFileTile,
  MessageMediaRow,
  MessageMediaTile,
} from '@canopy/ui-shared/components';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { useDesktopMediaViewer } from '@/components/shared/useDesktopMediaViewer';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import { getFilenameFromPath } from '@/lib/file-type';
import type { SentAttachment } from '@/hooks/useSentAttachments';
import {
  cloudAttachmentIdOfPath,
  isCloudAttachmentPath,
} from '@/cloud-chats/cloud-chat-attachments';
import { CloudChatFileTargetContext } from '@/cloud-chats/cloud-chat-file-target';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { useGitHubStore } from '@/stores/githubStore';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';

/**
 * Everything sent with a user message, inside its bubble, in the shared
 * media row the web also mounts: images and videos as the pictures
 * themselves (a video as its first frame with a play mark), other files as
 * tiles with their type and name. Clicking an image or a video opens the
 * message's pictures and videos in the in-app viewer, at that one; clicking
 * a file opens it in the system's default app. A cloud chat's attachment has
 * no file on this computer, so it saves through that chat's own web core
 * read instead (CAN-6771). Resting on a file shows its preview.
 */
export function MessageImages({
  attachments,
  alone = false,
}: {
  readonly attachments: readonly SentAttachment[];
  /** The message has no text under the row. */
  readonly alone?: boolean;
}): JSX.Element | null {
  const addToast = useGitHubStore((state) => state.addToast);
  const {
    hoveredPath,
    anchorRef,
    handleMouseEnter,
    handleMouseLeave,
    popoverMouseEnter,
    popoverMouseLeave,
  } = useAttachmentHover();
  // One failure notice for both ways a tile opens its file.
  const failed = useCallback(
    (action: 'open' | 'save', absolutePath: string): void => {
      addToast(
        `Couldn't ${action} ${getFilenameFromPath(absolutePath)}.`,
        'error',
        undefined,
        { forceInApp: true },
      );
    },
    [addToast],
  );
  const open = useCallback(
    (absolutePath: string): void => {
      void window.api
        .openExternalFile({ absolutePath })
        .catch(() => failed('open', absolutePath));
    },
    [failed],
  );
  const cloudTarget = useContext(CloudChatFileTargetContext);
  const save = useCallback(
    (absolutePath: string): void => {
      const id = cloudAttachmentIdOfPath(absolutePath);
      if (cloudTarget === null || id === null) return;
      void window.api.cloudChats
        .downloadFile(cloudTarget, {
          kind: 'attachment',
          id,
          filename: getFilenameFromPath(absolutePath),
        })
        .then(
          (result) => {
            // A cancelled save dialog is no failure.
            if (!result.ok && result.reason !== 'canceled')
              failed('save', absolutePath);
          },
          () => failed('save', absolutePath),
        );
    },
    [cloudTarget, failed],
  );
  // The message's images and videos, in attach order: the viewer's set. A
  // cloud chat's attachment has no file on this computer to show. A video is
  // read through the chat's own worktree, which need not be the selected one
  // (a chat in a pulled-out panel).
  const chatTarget = useContext(ChatMarkdownFileTargetContext);
  // A read-only transcript's videos cannot be read for the viewer: a
  // published chat's byte reader serves the sealed copy's repositories only,
  // and a retained chat's review scope has no file roots. There the viewer
  // holds the images. A published chat may not hand a file to another app
  // either; a retained chat's files are this computer's own, so its videos
  // open in their default app, as they did before the viewer.
  const access = useWorkspaceAccess();
  const readOnly = access.mode === 'read-only';
  const sealed = readOnly && access.reason === 'shared-container';
  const { open: openViewer, viewer } = useDesktopMediaViewer(
    chatTarget ?? undefined,
    { canOpenExternal: !sealed },
  );
  const media = useMemo(
    () =>
      attachments.flatMap((attachment) =>
        attachment.kind === 'file' ||
        (readOnly && attachment.kind === 'video') ||
        isCloudAttachmentPath(attachment.absolutePath)
          ? []
          : [
              {
                absolutePath: attachment.absolutePath,
                kind: attachment.kind,
              },
            ],
      ),
    [attachments, readOnly],
  );
  const openMedia = useCallback(
    (absolutePath: string): void => {
      openViewer(
        media,
        media.findIndex((item) => item.absolutePath === absolutePath),
      );
    },
    [media, openViewer],
  );
  if (attachments.length === 0) return null;
  return (
    <>
      <MessageMediaRow alone={alone}>
        {attachments.map((attachment) => {
          const { absolutePath } = attachment;
          const name = getFilenameFromPath(absolutePath);
          // A cloud chat's attachment has no file on this computer to open:
          // it saves through its chat, when the transcript names one.
          const cloud = isCloudAttachmentPath(absolutePath);
          const onOpen = !cloud
            ? (): void => open(absolutePath)
            : cloudTarget !== null
              ? (): void => save(absolutePath)
              : undefined;
          return attachment.kind === 'file' ? (
            <MessageFileTile
              key={absolutePath}
              file={{
                key: absolutePath,
                name,
                ...(onOpen === undefined ? {} : { onOpen }),
                onHoverStart: (anchor): void =>
                  handleMouseEnter(absolutePath, anchor),
                onHoverEnd: handleMouseLeave,
              }}
            />
          ) : (
            <MessageMediaTile
              key={absolutePath}
              image={{
                key: absolutePath,
                src: attachment.src,
                kind: attachment.kind,
                alt: name,
                ...(cloud
                  ? onOpen === undefined
                    ? {}
                    : { onOpen }
                  : readOnly && attachment.kind === 'video'
                    ? sealed
                      ? {}
                      : { onOpen }
                    : { onOpen: (): void => openMedia(absolutePath) }),
              }}
            />
          );
        })}
      </MessageMediaRow>
      {viewer}
      {hoveredPath && (
        <AttachmentPreviewPopover
          absolutePath={hoveredPath}
          filename={getFilenameFromPath(hoveredPath)}
          anchorRef={anchorRef}
          onMouseEnter={popoverMouseEnter}
          onMouseLeave={popoverMouseLeave}
        />
      )}
    </>
  );
}
