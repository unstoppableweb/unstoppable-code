import { useCallback, type JSX, type MouseEvent } from 'react';
import { CheckIcon } from '../icons/CheckIcon';
import { CopyIcon } from '../icons/CopyIcon';
import { Button } from './Button';
import { CopyStatusRegion, useAnnouncedCopy } from './copy-feedback';
import { Tooltip } from './Tooltip';

/**
 * The user bubble's copy badge name (CAN-5354). One word, like every copy
 * icon's tooltip: the badge sits on the message it copies.
 */
const USER_BUBBLE_COPY_LABEL = 'Copy';

export interface BubbleCopyBadgeProps {
  /** Plain text written to the clipboard. */
  copyText: string;
  /** Accessible name and tooltip before the copy lands. */
  label?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

/**
 * A message bubble's corner copy action. It shares the copy behavior with
 * `CopyButton` and is drawn as the 28px secondary icon Button, the same
 * recipe as the revert badge beside it. Its name and tooltip are `Copy`, and
 * a polite status announces `Copied` (CAN-5354). The cluster reveals on focus-within, so
 * tabbing to the badge shows it.
 */
export function BubbleCopyBadge(props: BubbleCopyBadgeProps): JSX.Element {
  return <BubbleCopyBadgeControl key={props.copyText} {...props} />;
}

function BubbleCopyBadgeControl({
  copyText,
  label = USER_BUBBLE_COPY_LABEL,
  dataTestId,
}: BubbleCopyBadgeProps): JSX.Element {
  const { copied, announcement, copy } = useAnnouncedCopy();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      event.preventDefault();
      void copy(copyText, event.currentTarget.ownerDocument);
    },
    [copy, copyText],
  );
  const name = copied ? 'Copied' : label;
  return (
    <span className="relative inline-flex">
      <Tooltip label={name}>
        <Button
          variant="secondary"
          size="compact"
          iconOnly
          onClick={handleClick}
          aria-label={name}
          data-testid={dataTestId}
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon />}
        </Button>
      </Tooltip>
      {/* Mounted only around a copy, so a long transcript does not carry a
          status per prompt; it mounts empty and fills a beat later. */}
      {copied && <CopyStatusRegion announcement={announcement} />}
    </span>
  );
}
