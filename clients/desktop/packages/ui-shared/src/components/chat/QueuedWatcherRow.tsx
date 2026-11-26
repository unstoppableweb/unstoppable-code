import { memo, type JSX, type ReactNode } from 'react';
import type {
  ChatWatcherFiredInfo,
  QueuedMessageWaitingReason,
} from '@canopy/protocol/remote-control/shell';
import { TrashIcon } from '../../icons/AppIcons';
import { Button } from '../../primitives/Button';
import { WakeTurnBoundary } from '../WakeTurnBoundary';
import { QueuedMessageReason } from './QueuedMessageReason';
import { watcherFiredPresentation } from './WatcherFiredTitle';

export interface QueuedWatcherRowProps {
  readonly watcherFired: ChatWatcherFiredInfo;
  /** The queued message's text; its readable part goes in the details. */
  readonly text: string;
  readonly reason?: string;
  readonly waitingReason?: QueuedMessageWaitingReason;
  readonly onCancel?: () => void;
  /** The message is being handed to the agent: Clear is disabled. */
  readonly pending?: boolean;
  readonly cancelLabel?: string;
  /** The host's Steer, Interrupt, Retry and Run now strip. */
  readonly footer?: ReactNode;
  /** Replaces the Queued status, such as an input delivery's “Sending…”. */
  readonly status?: ReactNode;
  /** Replaces Clear at the row's end with the host's own controls. */
  readonly actions?: ReactNode;
  readonly dataTestId?: string;
}

/**
 * A fired watcher's message waiting behind the running turn. It is the same
 * quiet row as the wake it becomes (chat-blocks.md, Watchers), saying “Will
 * wake” with a Queued status, instead of an info bubble. Clear sits at the
 * row's end on hover; the host's queue actions keep their place below.
 */
export const QueuedWatcherRow = memo(function QueuedWatcherRow({
  watcherFired,
  text,
  reason,
  waitingReason,
  onCancel,
  pending = false,
  cancelLabel = 'Clear queued message',
  footer,
  status,
  actions,
  dataTestId = 'queued-watcher-row',
}: QueuedWatcherRowProps): JSX.Element {
  return (
    <div className="min-w-0" data-testid={dataTestId}>
      <WakeTurnBoundary
        queued
        status={status}
        watcher={watcherFired}
        followUp={watcherFiredPresentation(text, 'block', watcherFired)?.text}
        extraDetails={
          reason ? (
            <QueuedMessageReason reason={reason} spacing="parent" />
          ) : waitingReason !== undefined ? (
            <QueuedMessageReason
              waitingReason={waitingReason}
              spacing="parent"
            />
          ) : undefined
        }
        actions={
          actions ??
          (onCancel ? (
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              data-testid="queued-message-cancel"
              disabled={pending}
              onClick={onCancel}
              aria-label={cancelLabel}
            >
              <TrashIcon size="sm" />
            </Button>
          ) : undefined)
        }
      />
      {footer}
    </div>
  );
});
