import { memo, useCallback, type JSX, type ReactNode } from 'react';
import type { AttachmentMeta } from '@canopy/desktop-shared/types';
import { LinearLogo } from '@canopy/ui-shared/icons';
import { useHorizontalOverflowScroll } from '@canopy/ui-shared/lib';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import { useFilePreview } from '@/hooks/useFilePreview';
import { IMAGE_FILENAME } from '@/lib/file-type';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import {
  AttachmentCardTile,
  AttachmentImageTile,
  AttachmentTextPreview,
  AttachmentTileRemoveButton,
} from './AttachmentTile';

interface AttachmentPillCarouselProps {
  attachments: AttachmentMeta[];
  onRemove: (absolutePath: string) => void;
  /** Tiles that lead the strip (the code selections staged on the draft). */
  leading?: ReactNode;
}

/** Characters of a text file shown on its card: about its first lines. */
const TEXT_SNIPPET_LENGTH = 400;

/**
 * One attachment: an image as a square thumbnail, any other file as a card
 * with a glimpse of its content above its name.
 */
function AttachmentTile({
  attachment,
}: {
  readonly attachment: AttachmentMeta;
}): JSX.Element {
  // A Linear ticket is a generated prompt file: its card names the ticket.
  const previewable = attachment.promptKind !== 'linear-ticket';
  const state = useFilePreview(attachment.absolutePath, previewable);
  const preview = state.status === 'ready' ? state.preview : null;
  const image =
    preview?.kind === 'image' ||
    (state.status === 'loading' &&
      previewable &&
      IMAGE_FILENAME.test(attachment.filename));

  if (image) {
    return (
      <AttachmentImageTile>
        {preview?.kind === 'image' ? (
          <img
            src={preview.content}
            alt={attachment.filename}
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : null}
      </AttachmentImageTile>
    );
  }

  const snippet =
    preview?.kind === 'text' ||
    preview?.kind === 'markdown' ||
    preview?.kind === 'html'
      ? preview.content.slice(0, TEXT_SNIPPET_LENGTH)
      : null;
  return (
    <AttachmentCardTile
      kind="file"
      preview={
        snippet !== null ? (
          <AttachmentTextPreview text={snippet} />
        ) : state.status === 'loading' && previewable ? null : (
          <span className="fg-tertiary">
            {attachment.promptKind === 'linear-ticket' ? (
              <LinearLogo width={28} height={28} className="shrink-0" />
            ) : (
              <FileTypeIcon
                filename={attachment.filename}
                size="2xl"
                className="shrink-0"
              />
            )}
          </span>
        )
      }
      icon={
        attachment.promptKind === 'linear-ticket' ? (
          <LinearLogo width={16} height={16} className="shrink-0" />
        ) : (
          <FileTypeIcon
            filename={attachment.filename}
            size="md"
            className="shrink-0"
          />
        )
      }
      name={attachment.filename}
    />
  );
}

/**
 * The composer's attachments: a strip of tiles that scrolls sideways (a plain
 * mouse wheel pans it too), led by any code selections. Hovering a tile shows
 * its remove button in the corner and, for a file, a larger preview above it.
 */
export const AttachmentPillCarousel = memo(function AttachmentPillCarousel({
  attachments,
  onRemove,
  leading,
}: AttachmentPillCarouselProps): JSX.Element {
  const {
    hoveredPath,
    anchorRef,
    handleMouseEnter,
    handleMouseLeave,
    popoverMouseEnter,
    popoverMouseLeave,
  } = useAttachmentHover();
  const strip = useHorizontalOverflowScroll<HTMLDivElement>();

  const hoveredAttachment = hoveredPath
    ? attachments.find((a) => a.absolutePath === hoveredPath)
    : undefined;

  const onTileMouseEnter = useCallback(
    (attachment: AttachmentMeta, e: React.MouseEvent<HTMLDivElement>): void => {
      handleMouseEnter(attachment.absolutePath, e.currentTarget);
    },
    [handleMouseEnter],
  );

  return (
    // The 8px inset is the toolbar row's, so the first tile starts where +
    // does; it also leaves room for the remove buttons that overhang each
    // tile's corner, which the scroll container would otherwise clip.
    <div
      ref={strip.ref}
      data-testid="attachment-strip"
      className="flex gap-3 overflow-x-auto px-2 pb-1 pt-2 scrollbar-hide"
    >
      {leading}
      {attachments.map((attachment) => (
        <div
          key={attachment.absolutePath}
          className="group relative shrink-0"
          data-testid="attachment-pill"
          title={attachment.filename}
          onMouseEnter={(e): void => onTileMouseEnter(attachment, e)}
          onMouseLeave={handleMouseLeave}
        >
          <AttachmentTile attachment={attachment} />
          <AttachmentTileRemoveButton
            label={attachment.filename}
            onRemove={(): void => onRemove(attachment.absolutePath)}
          />
        </div>
      ))}
      {hoveredPath && (
        <AttachmentPreviewPopover
          absolutePath={hoveredPath}
          filename={hoveredAttachment?.filename}
          anchorRef={anchorRef}
          placement="above"
          onMouseEnter={popoverMouseEnter}
          onMouseLeave={popoverMouseLeave}
        />
      )}
    </div>
  );
});
