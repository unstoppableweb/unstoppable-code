import { memo, type JSX, type ReactNode } from 'react';
import { Stack } from '../Stack';
import type { QueuedMessageWaitingReason } from '@canopy/protocol/remote-control/shell';
import { Tooltip } from '../Tooltip';

/**
 * Copy for each host-reported reason a queued message is waiting. Product
 * copy, not conversation content: it describes what will happen, never the
 * turn or steering internals behind it.
 */
export const QUEUED_MESSAGE_WAITING_REASON_COPY: Readonly<
  Record<QueuedMessageWaitingReason, string>
> = {
  steer_unavailable: 'Sends as soon as the agent can take it.',
  background_work:
    'Sends when background work finishes, so your new settings can apply. Run now sends it without them.',
  settings_change:
    'Sends after the current reply so your new settings can apply.',
};

export type QueuedMessageReasonProps = {
  /** The surrounding queued-content group owns the gap. Inline rows are unchanged. */
  readonly spacing?: 'parent';
} & (
  | {
      /** Free-text reason supplied by the caller, rendered as given. */
      readonly reason: string;
      readonly waitingReason?: never;
    }
  | {
      /** Host-reported reason; the unit maps it to its copy. */
      readonly waitingReason: QueuedMessageWaitingReason;
      /** Compact queue rows keep the full explanation in their tooltip. */
      readonly layout?: 'stack' | 'inline';
      readonly reason?: never;
    }
);

/** The label and reason share one readable size and ink. */
export const QUEUED_MESSAGE_LABEL_TEXT_CLASS = 'text-xs fg-secondary';
/** Compatibility for callers whose parent has not adopted the queued content group. */
export const QUEUED_MESSAGE_LABEL_CLASS = `pb-1 ${QUEUED_MESSAGE_LABEL_TEXT_CLASS}`;

export const QueuedMessageReason = memo(function QueuedMessageReason(
  props: QueuedMessageReasonProps,
): JSX.Element {
  const reasonClass =
    props.spacing === 'parent'
      ? QUEUED_MESSAGE_LABEL_TEXT_CLASS
      : QUEUED_MESSAGE_LABEL_CLASS;
  if (props.waitingReason !== undefined) {
    if (props.layout === 'inline') {
      const text = QUEUED_MESSAGE_WAITING_REASON_COPY[props.waitingReason];
      return (
        <Tooltip label={text} allowShrink>
          <span
            className="min-w-0 truncate text-xs fg-tertiary"
            data-testid="queued-message-waiting-reason"
            data-waiting-reason={props.waitingReason}
          >
            {text}
          </span>
        </Tooltip>
      );
    }
    return (
      <div
        className={reasonClass}
        data-testid="queued-message-waiting-reason"
        data-waiting-reason={props.waitingReason}
      >
        {QUEUED_MESSAGE_WAITING_REASON_COPY[props.waitingReason]}
      </div>
    );
  }
  return <div className={reasonClass}>{props.reason}</div>;
});

/** Shared queued/scheduled label, reason and body rhythm inside MessageEditSurface. */
export function QueuedMessageContent({
  label = 'Queued',
  heading,
  reason,
  waitingReason,
  children,
}: {
  readonly label?: ReactNode;
  /** Existing title controls retain their internal spacing in this normal-flow slot. */
  readonly heading?: ReactNode;
  readonly reason?: string;
  readonly waitingReason?: QueuedMessageWaitingReason;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <Stack gap="tight">
      <div className={QUEUED_MESSAGE_LABEL_TEXT_CLASS + ' empty:hidden'}>
        {label}
      </div>
      <div>
        {heading}
        <Stack gap="tight">
          {reason ? (
            <QueuedMessageReason reason={reason} spacing="parent" />
          ) : waitingReason !== undefined ? (
            <QueuedMessageReason
              waitingReason={waitingReason}
              spacing="parent"
            />
          ) : null}
          <div>{children}</div>
        </Stack>
      </div>
    </Stack>
  );
}
