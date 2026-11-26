import {
  cloudAttachmentPreview,
  isCloudAttachmentPath,
} from '@/cloud-chats/cloud-chat-attachments';
import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { AttachmentPreviewCard } from '@canopy/ui-shared/components';
import type { FilePreviewResponse } from '@canopy/desktop-shared/types';
import { getFilenameFromPath } from '@/lib/file-type';
import { useGitHubStore } from '@/stores/githubStore';

interface AttachmentPreviewPopoverProps {
  absolutePath: string;
  filename?: string;
  sizeBytes?: number;
  createdAt?: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: 'auto' | 'above';
  onOpen?: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * The desktop's attachment preview: reads the file through main (or a cloud
 * chat's cached copy) and opens it on Open, around the shared
 * `AttachmentPreviewCard`.
 */
export const AttachmentPreviewPopover = memo(function AttachmentPreviewPopover({
  absolutePath,
  filename,
  sizeBytes,
  createdAt,
  anchorRef,
  placement = 'auto',
  onOpen,
  onMouseEnter,
  onMouseLeave,
}: AttachmentPreviewPopoverProps): JSX.Element | null {
  const [preview, setPreview] = useState<FilePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const addToast = useGitHubStore((state) => state.addToast);

  const displayName = filename ?? getFilenameFromPath(absolutePath);
  const displaySizeBytes = sizeBytes ?? preview?.sizeBytes;

  // Fetch preview content
  useEffect(() => {
    // A cloud chat's attachment is never read through main.
    const cloud = cloudAttachmentPreview(absolutePath);
    if (cloud !== undefined) {
      setPreview(cloud);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);

    void window.api
      .readFilePreview({ absolutePath })
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Unable to load preview');
          setLoading(false);
        }
      });

    return (): void => {
      cancelled = true;
    };
  }, [absolutePath]);

  const handleOpen = useCallback((): void => {
    if (onOpen) {
      onOpen();
      return;
    }
    void window.api.openExternalFile({ absolutePath }).catch((error) => {
      addToast(`Couldn't open ${displayName}.`, 'error', undefined, {
        forceInApp: true,
        caught: error,
      });
    });
  }, [absolutePath, addToast, displayName, onOpen]);

  return (
    <AttachmentPreviewCard
      name={displayName}
      sizeBytes={displaySizeBytes}
      createdAt={createdAt}
      loading={loading}
      error={error}
      preview={preview}
      // A cloud chat's attachment has no file here to open.
      onOpen={
        onOpen !== undefined || !isCloudAttachmentPath(absolutePath)
          ? handleOpen
          : undefined
      }
      anchorRef={anchorRef}
      placement={placement}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  );
});
