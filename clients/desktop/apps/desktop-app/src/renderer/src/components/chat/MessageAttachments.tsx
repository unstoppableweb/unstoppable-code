import type { JSX } from 'react';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { getFilenameFromPath } from '@/lib/file-type';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import { FileAttachmentChip } from '@canopy/ui-shared/components';

interface MessageAttachmentsProps {
  attachmentPaths: readonly string[] | undefined;
}

export function MessageAttachments({
  attachmentPaths,
}: MessageAttachmentsProps): JSX.Element | null {
  const {
    hoveredPath,
    anchorRef,
    handleMouseEnter,
    handleMouseLeave,
    popoverMouseEnter,
    popoverMouseLeave,
  } = useAttachmentHover();

  if (!attachmentPaths || attachmentPaths.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {attachmentPaths.map((filePath) => {
        const filename = getFilenameFromPath(filePath);
        return (
          <FileAttachmentChip
            key={filePath}
            filename={filename}
            onMouseEnter={(event): void =>
              handleMouseEnter(filePath, event.currentTarget)
            }
            onMouseLeave={handleMouseLeave}
            icon={
              <FileTypeIcon
                filename={filename}
                size="sm"
                className="shrink-0"
              />
            }
          />
        );
      })}
      {hoveredPath && (
        <AttachmentPreviewPopover
          absolutePath={hoveredPath}
          filename={getFilenameFromPath(hoveredPath)}
          anchorRef={anchorRef}
          onMouseEnter={popoverMouseEnter}
          onMouseLeave={popoverMouseLeave}
        />
      )}
    </div>
  );
}
