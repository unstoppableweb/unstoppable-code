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
import { isCloudAttachmentPath } from '@/cloud-chats/cloud-chat-attachments';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { useGitHubStore } from '@/stores/githubStore';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';

/**
 * Everything sent with a user message, inside its bubble, in the shared
 * media row the web also mounts: images and videos as the pictures
 * themselves (a video as its first frame with a play mark), other files as
 * tiles with their type and name. Clicking an image or a video opens the
 * message's pictures and videos in the in-app viewer, at that one; clicking
 * a file opens it in the system's default app. Resting on a file shows its
 * preview. A cloud chat's attachments are the shared message media's instead
 * (CAN-6775).
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
  const chatTarget = useContext(ChatMarkdownFileTargetContext);
  const isPairedScope =
    chatTarget !== null && isPairedComputerId(chatTarget.projectId);
  const open = useCallback(
    (absolutePath: string): void => {
      if (isPairedScope) return;
      void window.api.openExternalFile({ absolutePath }).catch(() => {
        addToast(
          `Couldn't open ${getFilenameFromPath(absolutePath)}.`,
          'error',
          undefined,
          { forceInApp: true },
        );
      });
    },
    [addToast, isPairedScope],
  );
  // The message's images and videos, in attach order: the viewer's set. A
  // cloud chat's attachment has no file on this computer to show. A video is
  // read through the chat's own worktree, which need not be the selected one
  // (a chat in a pulled-out panel).
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
          // A cloud chat's attachment has no file on this computer to open.
          const cloud = isCloudAttachmentPath(absolutePath);
          const onOpen =
            isPairedScope || cloud ? undefined : (): void => open(absolutePath);
          return attachment.kind === 'file' ? (
            <MessageFileTile
              key={absolutePath}
              file={{
                key: absolutePath,
                name,
                ...(onOpen === undefined ? {} : { onOpen }),
                ...(isPairedScope
                  ? {}
                  : {
                      onHoverStart: (anchor): void =>
                        handleMouseEnter(absolutePath, anchor),
                      onHoverEnd: handleMouseLeave,
                    }),
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
                ...(onOpen === undefined
                  ? {}
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
      {!isPairedScope && hoveredPath && (
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
