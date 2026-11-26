import { ControlButton } from '../../primitives/Button';
import {
  memo,
  useId,
  type JSX,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { DownloadIcon, FileTypeIcon } from '../../icons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

export interface FileAttachmentChipProps {
  readonly filename: string;
  readonly icon?: ReactNode;
  readonly onDownload?: () => void;
  readonly onMouseEnter?: MouseEventHandler<HTMLSpanElement>;
  readonly onMouseLeave?: MouseEventHandler<HTMLSpanElement>;
  readonly onOpen?: () => void;
}

/** Compact file chip shared by message attachment surfaces. */
export const FileAttachmentChip = memo(function FileAttachmentChip({
  filename,
  icon,
  onDownload,
  onMouseEnter,
  onMouseLeave,
  onOpen,
}: FileAttachmentChipProps): JSX.Element {
  // Session replay records attributes, so the name lives only in blocked
  // text and the controls name it through aria-describedby.
  const nameId = useId();
  const label = (
    <>
      {icon ?? (
        // The type comes from the name, so it is blocked with it.
        <FileTypeIcon filename={filename} className={REPLAY_BLOCK_CLASS} />
      )}
      <span
        id={nameId}
        className={`${REPLAY_BLOCK_CLASS} truncate`}
        title={filename}
      >
        {filename}
      </span>
    </>
  );
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border bg-fg-primary/[0.04] px-2 py-1 text-xs fg-secondary"
      data-testid="file-attachment-chip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {onOpen === undefined ? (
        <span className="inline-flex min-w-0 items-center gap-1">{label}</span>
      ) : (
        <ControlButton
          type="button"
          onClick={onOpen}
          aria-label="Open attached file"
          aria-describedby={nameId}
          presentation="attachment-open"
        >
          {label}
        </ControlButton>
      )}
      {onDownload !== undefined && (
        <ControlButton
          type="button"
          onClick={onDownload}
          aria-label="Download attached file"
          aria-describedby={nameId}
          presentation="attachment-download"
        >
          <DownloadIcon size="sm" aria-hidden="true" />
        </ControlButton>
      )}
    </span>
  );
});
