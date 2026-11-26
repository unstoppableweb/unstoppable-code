import { useCallback, useId, type JSX, type MouseEvent } from 'react';
import { CheckIcon, CopyIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import type { ButtonSize } from '../primitives/Button';
import { CopyButton } from '../primitives/CopyButton';
import { NoticeButton } from '../primitives/Notice';
import { useCopyToClipboard } from '../primitives/copy-to-clipboard';

/** How long the `Copied` confirmation stays before the label returns. */
export const COPY_LINK_CONFIRMATION_MS = 2000;

/**
 * Where the control sits. `button` is the quiet ghost button of a dialog
 * footer; `notice` is the standard notice/toast action (`NoticeButton`), for
 * surfaces where Copy link sits beside other notice actions such as Open.
 */
export type CopyLinkButtonVariant = 'button' | 'notice';

export interface CopyLinkButtonProps {
  /** The link to write to the clipboard. */
  url: string;
  /** Host surface; picks the shared treatment. Defaults to `button`. */
  variant?: CopyLinkButtonVariant;
  /**
   * Button size for the `button` variant, so it matches the other actions in
   * its box (`compact` in a dialog footer). Defaults to `sm`; ignored by
   * `notice`.
   */
  size?: ButtonSize;
  /** Placement in the host. The treatment is not the caller's. */
  className?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Fires after a successful copy. */
  onCopy?: () => void;
  /** Host clipboard writer; defaults to the browser clipboard. */
  write?: (text: string) => Promise<boolean>;
  /**
   * Accessible name when one surface lists several links, for example
   * `Copy the Acme link for Deploy`. Defaults to `Copy link`; `Copied`
   * replaces it while the confirmation shows. Custom names are blocked
   * from replay and referenced by ID, never stored in recorded attributes.
   */
  ariaLabel?: string;
}

/**
 * Copy link as a notice action: the same `NoticeButton` a toast's other
 * actions use, with the copy glyph swapping to a check while `Copied` shows.
 */
function NoticeCopyLinkButton({
  url,
  className,
  dataTestId,
  onCopy,
  write,
  ariaLabel,
}: Omit<CopyLinkButtonProps, 'variant'>): JSX.Element {
  const labelId = useId();
  const { copied, copy } = useCopyToClipboard({
    copiedDurationMs: COPY_LINK_CONFIRMATION_MS,
    onCopy,
    ...(write !== undefined ? { write } : {}),
  });

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      event.preventDefault();
      void copy(url);
    },
    [copy, url],
  );

  const glyph = copied ? <CheckIcon size="sm" /> : <CopyIcon size="sm" />;

  return (
    <>
      <NoticeButton
        icon={glyph}
        data-testid={dataTestId}
        onClick={handleClick}
        {...(ariaLabel !== undefined && !copied
          ? { 'aria-labelledby': labelId }
          : {})}
        {...(className !== undefined ? { className } : {})}
      >
        {copied ? 'Copied' : 'Copy link'}
      </NoticeButton>
      {ariaLabel !== undefined && (
        <span id={labelId} className={`sr-only ${REPLAY_BLOCK_CLASS}`}>
          {ariaLabel}
        </span>
      )}
    </>
  );
}

/**
 * The one Copy link control. Every share surface uses it: the share dialog
 * footer and the desktop and web share toasts. It fixes the treatment in one
 * place (copy icon plus `Copy link`, then a check plus `Copied` for two
 * seconds), so restyling it restyles every share surface at once. Toasts use
 * the `notice` variant so Copy link matches the toast's other actions. A link
 * is only ever copied by a click on this button, never automatically.
 */
export function CopyLinkButton({
  url,
  variant = 'button',
  size = 'sm',
  className,
  dataTestId,
  onCopy,
  write,
  ariaLabel,
}: CopyLinkButtonProps): JSX.Element {
  const labelId = useId();
  if (variant === 'notice') {
    return (
      <NoticeCopyLinkButton
        url={url}
        {...(className !== undefined ? { className } : {})}
        {...(dataTestId !== undefined ? { dataTestId } : {})}
        {...(onCopy !== undefined ? { onCopy } : {})}
        {...(write !== undefined ? { write } : {})}
        {...(ariaLabel !== undefined ? { ariaLabel } : {})}
      />
    );
  }
  return (
    <>
      <CopyButton
        value={url}
        label="Copy link"
        copiedLabel="Copied"
        ariaLabel="Copy link"
        {...(ariaLabel !== undefined ? { ariaLabelledBy: labelId } : {})}
        title="Copy link"
        variant="ghost"
        size={size}
        copiedDurationMs={COPY_LINK_CONFIRMATION_MS}
        {...(className !== undefined ? { className } : {})}
        {...(dataTestId !== undefined ? { dataTestId } : {})}
        {...(onCopy !== undefined ? { onCopy } : {})}
        {...(write !== undefined ? { write } : {})}
      />
      {ariaLabel !== undefined && (
        <span id={labelId} className={`sr-only ${REPLAY_BLOCK_CLASS}`}>
          {ariaLabel}
        </span>
      )}
    </>
  );
}
