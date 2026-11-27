import {
  cloudAttachmentPreview,
  isCloudAttachmentPath,
} from '@/cloud-chats/cloud-chat-attachments';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useState,
  type JSX,
} from 'react';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { ChatMarkdownFileTargetContext } from '@/components/chat/chat-markdown-file-target';
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

  const chatTarget = useContext(ChatMarkdownFileTargetContext);
  const isPairedScope =
    chatTarget !== null && isPairedComputerId(chatTarget.projectId);

  const displayName = filename ?? getFilenameFromPath(absolutePath);
  const displaySizeBytes = sizeBytes ?? preview?.sizeBytes;

  // Fetch preview content
  useEffect(() => {
    // A paired computer's attachment belongs to another machine and must never
    // be read through this computer's local file-preview IPC.
    if (isPairedScope) {
      setPreview(null);
      setError('Unable to load preview');
      setLoading(false);
      return undefined;
    }
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
  }, [absolutePath, isPairedScope]);

  const handleOpen = useCallback((): void => {
    if (isPairedScope) return;
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
  }, [absolutePath, addToast, displayName, isPairedScope, onOpen]);

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
        !isPairedScope &&
        (onOpen !== undefined || !isCloudAttachmentPath(absolutePath))
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
