import {
  cloudAttachmentPreview,
  isCloudAttachmentPath,
} from '@/cloud-chats/cloud-chat-attachments';
import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import {
  Button,
  Markdown,
  RichHoverCard,
  CenteredLoadingSpinner,
  Skeleton,
} from '@canopy/ui-shared/components';
import type { FilePreviewResponse } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { FileIcon } from '@canopy/ui-shared/icons';
import { getFilenameFromPath } from '@/lib/file-type';
import { useGitHubStore } from '@/stores/githubStore';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Holds the image's place, at the preview's height, until it decodes. A
 * spinner, not a skeleton: the image's shape is unknown until it arrives.
 */
function ImageLoading(): JSX.Element {
  return (
    <div className="flex h-30 w-full">
      <CenteredLoadingSpinner />
    </div>
  );
}

function ImagePreview({ src }: { src: string }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex items-center justify-center bg-fg-primary/[0.02] p-2">
      {!loaded && <ImageLoading />}
      <img
        src={src}
        alt=""
        className={`max-h-50 max-w-full rounded object-contain${loaded ? '' : ' hidden'}`}
        onLoad={(): void => setLoaded(true)}
      />
    </div>
  );
}

function TruncatedLabel(): JSX.Element {
  return (
    <div className="px-2 pb-2 pt-1 text-3xs italic fg-secondary">
      Preview truncated
    </div>
  );
}

function TextPreview({
  content,
  truncated,
}: {
  content: string;
  truncated: boolean;
}): JSX.Element {
  return (
    <div className="max-h-50 overflow-y-auto">
      <pre className="whitespace-pre-wrap break-words p-2 font-mono text-2xs leading-relaxed fg-primary/80">
        {content}
      </pre>
      {truncated && <TruncatedLabel />}
    </div>
  );
}

function MarkdownPreview({
  content,
  truncated,
}: {
  content: string;
  truncated: boolean;
}): JSX.Element {
  return (
    <div className="max-h-50 overflow-y-auto">
      <div className="p-2 text-xs fg-primary/80">
        <Markdown>{content}</Markdown>
      </div>
      {truncated && <TruncatedLabel />}
    </div>
  );
}

function UnsupportedPreview(): JSX.Element {
  return (
    <div className="flex h-20 items-center justify-center text-xs fg-secondary">
      Preview not available
    </div>
  );
}

function LoadingSkeleton(): JSX.Element {
  return (
    <div className="p-3">
      <Skeleton loading label="Loading preview">
        <div className="flex flex-col gap-2 text-xs">
          <p>The first line of this attachment</p>
          <p>A shorter second line</p>
          <p>The third line of the file</p>
        </div>
      </Skeleton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main popover
// ---------------------------------------------------------------------------

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
    void window.api.openExternalFile({ absolutePath }).catch(() => {
      addToast(`Couldn't open ${displayName}.`, 'error', undefined, {
        forceInApp: true,
      });
    });
  }, [absolutePath, addToast, displayName, onOpen]);

  return (
    <RichHoverCard
      anchorRef={anchorRef}
      placement={placement}
      interactive
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      elevation="menu"
      surfacePadding="flush"
      surfaceClassName="w-70"
    >
      {/* Header */}
      <div className="shrink-0 border-b px-3 py-2">
        <div className="truncate text-xs font-medium fg-primary">
          {displayName}
        </div>
        {displaySizeBytes !== undefined && (
          <div className="text-3xs fg-secondary">
            {formatFileSize(displaySizeBytes)}
          </div>
        )}
        {createdAt !== undefined && (
          <div className="text-3xs fg-secondary">
            Created {new Date(createdAt).toLocaleString()}
          </div>
        )}
      </div>

      {/* Preview body. Portaled to the body, out of the composer's and
          transcript's replay blocks, so it carries its own: the attachment's
          contents. The header (name, size) and footer stay recorded. */}
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-auto`}
        data-selectable
        data-testid="attachment-preview-body"
      >
        {loading && <LoadingSkeleton />}
        {error && (
          <div className="flex h-20 items-center justify-center text-xs fg-secondary">
            {error}
          </div>
        )}
        {preview && !loading && !error && (
          <>
            {preview.kind === 'image' && <ImagePreview src={preview.content} />}
            {preview.kind === 'text' && (
              <TextPreview
                content={preview.content}
                truncated={preview.truncated}
              />
            )}
            {preview.kind === 'markdown' && (
              <MarkdownPreview
                content={preview.content}
                truncated={preview.truncated}
              />
            )}
            {preview.kind === 'unsupported' && <UnsupportedPreview />}
          </>
        )}
      </div>

      {/* Footer: a cloud chat's attachment has no file here to open. */}
      {onOpen !== undefined || !isCloudAttachmentPath(absolutePath) ? (
        <div className="flex shrink-0 border-t px-2 py-1.5">
          <Button variant="ghost" size="compact" onClick={handleOpen}>
            <FileIcon size="sm" />
            Open
          </Button>
        </div>
      ) : null}
    </RichHoverCard>
  );
});

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
