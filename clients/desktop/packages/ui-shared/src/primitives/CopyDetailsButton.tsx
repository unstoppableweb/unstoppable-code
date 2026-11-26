import { useCallback, type JSX } from 'react';
import { NoticeButton } from './Notice';
import { CopyStatusRegion, useAnnouncedCopy } from './copy-feedback';

export interface CopyDetailsButtonProps {
  /**
   * The raw failure text (a server reason, an exception message). Copied to
   * the clipboard and never rendered.
   */
  readonly details: string;
  readonly 'data-testid'?: string;
  /** Host clipboard writer; defaults to the browser clipboard. */
  readonly write?: (text: string) => Promise<boolean>;
}

/**
 * `Copy details`: the notice action that hands a raw failure reason to the
 * clipboard for support without showing it. Settings never render server
 * error text (docs/ux-writing.md); the notice says our sentence and this
 * button carries the details.
 */
export function CopyDetailsButton({
  details,
  'data-testid': dataTestId,
  write,
}: CopyDetailsButtonProps): JSX.Element {
  const { copied, failed, announcement, copy } = useAnnouncedCopy({
    failureAnnouncement: "Couldn't copy to the clipboard",
    ...(write !== undefined ? { write } : {}),
  });
  const onClick = useCallback((): void => {
    void copy(details);
  }, [copy, details]);
  return (
    <span className="relative">
      <NoticeButton onClick={onClick} data-testid={dataTestId}>
        {copied ? 'Copied' : 'Copy details'}
      </NoticeButton>
      {(copied || failed) && <CopyStatusRegion announcement={announcement} />}
    </span>
  );
}
