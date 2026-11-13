import { memo, useId, type JSX } from 'react';
import { DownloadIcon, FileIcon } from '../../icons';
import { Button } from '../Button';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

export interface FileDeliverableCardProps {
  readonly filename: string;
  readonly sizeBytes?: number;
  readonly description?: string;
  readonly pathLabel?: string;
  readonly status?: string;
  readonly busy?: boolean;
  readonly onDownload?: () => void;
  readonly onOpen?: () => void;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = sizeBytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function fileType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'md':
    case 'markdown':
      return 'Markdown document';
    case 'pdf':
      return 'PDF document';
    case 'docx':
    case 'doc':
      return 'Word document';
    case 'xlsx':
    case 'xls':
      return 'Spreadsheet';
    case 'csv':
      return 'CSV spreadsheet';
    case 'pptx':
    case 'ppt':
      return 'Presentation';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
    case 'svg':
      return 'Image';
    case 'html':
      return 'Web page';
    default:
      return extension && filename.includes('.')
        ? `${extension.toUpperCase()} file`
        : 'File';
  }
}

/** Display-only durable-file card; hosts provide all interactions. */
export const FileDeliverableCard = memo(function FileDeliverableCard({
  filename,
  sizeBytes,
  description,
  pathLabel,
  status,
  busy = false,
  onDownload,
  onOpen,
}: FileDeliverableCardProps): JSX.Element {
  // Session replay records attributes, so the name and description live
  // only in blocked text and the controls name them through
  // aria-describedby.
  const nameId = useId();
  const descriptionId = useId();
  const details = (
    <>
      <FileIcon size="xl" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span
          id={nameId}
          className={`${REPLAY_BLOCK_CLASS} block truncate text-xs font-medium fg-primary`}
          title={pathLabel ?? filename}
        >
          {filename}
        </span>
        <span
          id={descriptionId}
          className={`${REPLAY_BLOCK_CLASS} block truncate text-2xs fg-secondary`}
        >
          {description ?? fileType(filename)}
          {sizeBytes !== undefined ? ` · ${formatFileSize(sizeBytes)}` : ''}
        </span>
        {status && (
          <span className="block text-2xs fg-secondary" role="status">
            {status}
          </span>
        )}
      </span>
      {onOpen && <span className="text-2xs fg-secondary">Open</span>}
    </>
  );
  return (
    <div
      // The card insets a trailing Download 12px, as the row pads its text.
      className={`flex min-w-0 items-center rounded-md border bg-base${onDownload ? ' pr-3' : ''}`}
      data-testid="file-deliverable-card"
    >
      {onOpen ? (
        <button
          type="button"
          onClick={busy ? undefined : onOpen}
          aria-label="Open file"
          aria-describedby={`${nameId} ${descriptionId}`}
          aria-busy={busy}
          aria-disabled={busy}
          className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-3 text-left hover:bg-secondary"
        >
          {details}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3">
          {details}
        </div>
      )}
      {onDownload && (
        <Button
          variant="secondary"
          size="compact"
          onClick={onDownload}
          aria-label="Download file"
          aria-describedby={nameId}
        >
          <DownloadIcon size="sm" aria-hidden="true" />
          Download
        </Button>
      )}
    </div>
  );
});
