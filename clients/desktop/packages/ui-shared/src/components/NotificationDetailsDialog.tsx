import type { JSX, ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { DialogModal } from '../primitives/DialogModal';
import { SPACE_ROLE_GAP_CLASS, type SpaceRole } from '../primitives/Stack';

/** The kind of notification, which tints the message box's border and fill. */
export type NotificationDetailsTone = 'error' | 'info' | 'success' | 'warning';

function messageToneClasses(tone: NotificationDetailsTone | undefined): string {
  switch (tone) {
    case 'error':
      return 'border-line-destructive bg-destructive-subtle';
    case 'success':
      return 'border-line-positive bg-success-subtle';
    case 'warning':
      return 'border-line-attention bg-warning-subtle';
    case 'info':
      return 'bg-info-subtle';
    default:
      return '';
  }
}

export interface NotificationDetailsDialogProps {
  readonly title: ReactNode;
  readonly titleId?: string;
  /** The notification's full message, shown with its line breaks. */
  readonly message: ReactNode;
  readonly onClose: () => void;
  /** Keep the message out of session replay (it may quote command output). */
  readonly blockFromReplay?: boolean;
  /** Tints the message box for the notification's kind; untinted without it. */
  readonly tone?: NotificationDetailsTone;
  /** Rendered above the message. */
  readonly leading?: ReactNode;
  /** Rendered below the message. */
  readonly trailing?: ReactNode;
  /** Space around margin-free metadata and actions; omitted retains legacy placement. */
  readonly slotGap?: SpaceRole;
  /** Test ID on the dialog card; the message box gets `<id>-body`. */
  readonly dataTestId?: string;
  /** Move focus into the dialog and return it to the opener on close (default: true). */
  readonly trapFocus?: boolean;
}

/**
 * A notification's message in full. The preview a toast or notice shows is
 * cut short; this dialog scrolls the whole text inside a bounded box, so a
 * long command output never runs off the window.
 */
export function NotificationDetailsDialog({
  title,
  titleId,
  message,
  onClose,
  blockFromReplay = false,
  tone,
  leading,
  trailing,
  slotGap,
  dataTestId,
  trapFocus = true,
}: NotificationDetailsDialogProps): JSX.Element {
  return (
    <DialogModal
      onClose={onClose}
      title={title}
      titleId={titleId}
      maxWidth="2xl"
      dataTestId={dataTestId}
      trapFocus={trapFocus}
    >
      <div
        className={`flex flex-1 flex-col overflow-hidden${slotGap === undefined ? '' : ` ${SPACE_ROLE_GAP_CLASS[slotGap]}`}`}
      >
        {leading}
        <div
          data-testid={
            dataTestId === undefined ? undefined : `${dataTestId}-body`
          }
          // Focusable, so Safari keyboard users can scroll long output.
          tabIndex={0}
          role="region"
          aria-label="Message"
          className={`${blockFromReplay ? REPLAY_BLOCK_CLASS : ''} focus-ring focus-ring-inset overflow-y-auto whitespace-pre-wrap rounded-lg border p-4 text-s fg-primary/90 ${messageToneClasses(tone)}`}
          style={{ maxHeight: '60vh' }}
        >
          {/* Git rewrites progress lines with a bare \r, which CSS does not
              break on. */}
          {typeof message === 'string'
            ? message.replace(/\r\n?/g, '\n')
            : message}
        </div>
        {trailing}
      </div>
    </DialogModal>
  );
}
