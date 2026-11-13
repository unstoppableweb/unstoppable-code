import { useCallback, type JSX } from 'react';
import {
  MessageFileTile,
  MessageMediaRow,
  MessageMediaTile,
} from '@canopy/ui-shared/components';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import { getFilenameFromPath } from '@/lib/file-type';
import type { SentAttachment } from '@/hooks/useSentAttachments';
import { isCloudAttachmentPath } from '@/cloud-chats/cloud-chat-attachments';
import { useGitHubStore } from '@/stores/githubStore';

/**
 * Everything sent with a user message, inside its bubble, in the shared
 * media row the web also mounts: images and videos as the pictures
 * themselves (a video as its first frame with a play mark), other files as
 * tiles with their type and name. Clicking one opens it in the system's
 * default app; resting on a file shows its preview.
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
  const open = useCallback(
    (absolutePath: string): void => {
      void window.api.openExternalFile({ absolutePath }).catch(() => {
        addToast(
          `Couldn't open ${getFilenameFromPath(absolutePath)}.`,
          'error',
          undefined,
          { forceInApp: true },
        );
      });
    },
    [addToast],
  );
  if (attachments.length === 0) return null;
  return (
    <>
      <MessageMediaRow alone={alone}>
        {attachments.map((attachment) => {
          const { absolutePath } = attachment;
          const name = getFilenameFromPath(absolutePath);
          // A cloud chat's attachment has no file on this computer to open.
          const opens = !isCloudAttachmentPath(absolutePath);
          return attachment.kind === 'file' ? (
            <MessageFileTile
              key={absolutePath}
              file={{
                key: absolutePath,
                name,
                ...(opens ? { onOpen: (): void => open(absolutePath) } : {}),
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
                ...(opens ? { onOpen: (): void => open(absolutePath) } : {}),
              }}
            />
          );
        })}
      </MessageMediaRow>
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
