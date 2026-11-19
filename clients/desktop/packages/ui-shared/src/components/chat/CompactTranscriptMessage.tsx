import type { JSX, ReactNode } from 'react';
import { HAIRLINE_INSET_RING_CLASS } from '../../lib/row-chips';
import { OPERATIONAL_STATUS_COLORS } from '../../lib/operational-status-colors';

const COPY_STYLE = {
  primary: 'fg-primary',
  secondary: 'fg-secondary',
  destructive: 'fg-destructive',
} as const;

const STATE_PAINT = {
  active: {
    surface: `${OPERATIONAL_STATUS_COLORS.active.ring} ${OPERATIONAL_STATUS_COLORS.active.backgroundSubtle}`,
    label: 'secondary',
    text: 'primary',
  },
  failed: {
    surface: `${OPERATIONAL_STATUS_COLORS.failed.ring} ${OPERATIONAL_STATUS_COLORS.failed.backgroundSubtle}`,
    label: 'destructive',
    text: 'destructive',
  },
  cancelled: {
    surface: 'ring-line-base bg-fg-primary/[0.04]',
    label: 'secondary',
    text: 'secondary',
  },
  user: {
    surface: 'ring-line-base bg-fg-primary/[0.06]',
    label: 'secondary',
    text: 'primary',
  },
  response: {
    surface: 'ring-line-base bg-card',
    label: 'secondary',
    text: 'primary',
  },
} as const;

/** An attributed message in a compact transcript without a full composer view. */
export function CompactTranscriptMessage({
  role,
  status,
  content,
  children,
}: {
  readonly role: string;
  readonly status: string;
  readonly content: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const isUser = role === 'user';
  const tone =
    status === 'streaming' || status === 'pending'
      ? STATE_PAINT.active
      : status === 'failed' || status === 'cancelled'
        ? STATE_PAINT[status]
        : isUser
          ? STATE_PAINT.user
          : STATE_PAINT.response;
  return (
    <li
      className={isUser ? 'flex justify-end' : 'block'}
      data-testid="remote-control-chat-message"
      data-status={status}
      data-role={role}
    >
      <div
        className={`${isUser ? 'max-w-17/20' : 'w-full'} flex flex-col rounded-xl px-3 py-2 ${HAIRLINE_INSET_RING_CLASS} ${tone.surface}`}
      >
        <p
          className={`flex items-center gap-1 pb-1 text-3xs ${COPY_STYLE[tone.label]}`}
        >
          <span>{role}</span>
          {status !== 'complete' && status !== 'completed' && (
            <span data-testid="remote-control-chat-message-status">
              · {status}
            </span>
          )}
        </p>
        {content && (
          <p
            className={`whitespace-pre-wrap ${COPY_STYLE[tone.text]}`}
            data-testid="remote-control-chat-message-content"
          >
            {content}
          </p>
        )}
        {children}
      </div>
    </li>
  );
}
