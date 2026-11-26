import { useState, type JSX, type RefObject } from 'react';
import { FileIcon } from '../icons/FileIcon';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Button } from '../primitives/Button';
import { CenteredLoadingSpinner } from '../primitives/CenteredLoadingSpinner';
import { CodeBlock } from '../primitives/CodeBlock';
import { HoverCard } from '../primitives/HoverCard';
import { Skeleton } from '../primitives/Skeleton';
import { Surface } from '../primitives/Surface';
import { ImageThumbnail } from './ImageThumbnail';
import { Markdown } from './Markdown';

/**
 * What an attachment's preview holds once read: an image's source, the
 * first part of a text or Markdown file, or nothing to show. `html` draws no
 * body. The desktop's `FilePreviewResponse` is assignable to it.
 */
export interface AttachmentPreviewContent {
  readonly kind: 'image' | 'text' | 'markdown' | 'html' | 'unsupported';
  readonly content: string;
  readonly truncated: boolean;
}

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
    <Surface
      variant="quiet-panel"
      padding="tight"
      className="flex items-center justify-center"
    >
      {!loaded && <ImageLoading />}
      <ImageThumbnail
        variant="attachment-preview"
        src={src}
        alt=""
        hidden={!loaded}
        onLoad={(): void => setLoaded(true)}
      />
    </Surface>
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
      <CodeBlock
        variant="document"
        inset="compact"
        size="2xs"
        wrap="words"
        tone="soft"
        replay="block"
        overflow="visible"
        proseLeading
      >
        {content}
      </CodeBlock>
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentPreviewCardProps {
  /** The attachment's name, shown in the header. */
  readonly name: string;
  readonly sizeBytes?: number;
  /** ISO time the attachment was created, shown under its size. */
  readonly createdAt?: string;
  /** The preview is being read. */
  readonly loading: boolean;
  /** Why the preview could not be read, shown in place of its body. */
  readonly error: string | null;
  readonly preview: AttachmentPreviewContent | null;
  /** Opens the file. Omit when there is nothing here to open: no footer. */
  readonly onOpen?: () => void;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly placement?: 'auto' | 'above';
  readonly onMouseEnter?: () => void;
  readonly onMouseLeave?: () => void;
}

/**
 * The card that previews a chat attachment over its pill or thumbnail: its
 * name and size, the start of its contents, and Open. The host reads the
 * preview and decides whether the file can be opened.
 */
export function AttachmentPreviewCard({
  name,
  sizeBytes,
  createdAt,
  loading,
  error,
  preview,
  onOpen,
  anchorRef,
  placement = 'auto',
  onMouseEnter,
  onMouseLeave,
}: AttachmentPreviewCardProps): JSX.Element {
  return (
    <HoverCard
      open
      anchorRef={anchorRef}
      placement={placement}
      interactive
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      elevation="menu"
      surfacePadding="flush"
      surfaceClassName="w-70"
      content={
        <>
          {/* Header */}
          <Surface
            variant="section"
            boundary="bottom"
            padding="section-compact"
            className="shrink-0"
          >
            <div className="truncate text-xs font-medium fg-primary">
              {name}
            </div>
            {sizeBytes !== undefined && (
              <div className="text-3xs fg-secondary">
                {formatFileSize(sizeBytes)}
              </div>
            )}
            {createdAt !== undefined && (
              <div className="text-3xs fg-secondary">
                Created {new Date(createdAt).toLocaleString()}
              </div>
            )}
          </Surface>

          {/* Preview body. Portaled to the body, out of the composer's and
          transcript's replay blocks, so it carries its own: the attachment's
          contents. The header (name, size) and footer stay recorded. */}
          <div
            className={`${REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-auto`}
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
                {preview.kind === 'image' && (
                  <ImagePreview src={preview.content} />
                )}
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

          {onOpen !== undefined ? (
            <Surface
              variant="section"
              boundary="top"
              padding="picker-section"
              className="flex shrink-0"
            >
              <Button variant="ghost" size="compact" onClick={onOpen}>
                <FileIcon size="sm" />
                Open
              </Button>
            </Surface>
          ) : null}
        </>
      }
    />
  );
}
