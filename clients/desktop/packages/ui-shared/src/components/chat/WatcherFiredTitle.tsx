'use client';

import { memo, type JSX, type ReactElement } from 'react';
import { visibleMessageParts } from '@canopy/agent-transcript';
import { AppAdvisorWatcherIcon } from '../../icons';
import type { ChatWatcherFiredInfo } from '@canopy/protocol/remote-control/shell';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../lib/replay-privacy';
import {
  RichHoverTooltip,
  type TooltipTriggerProps,
} from '../RichHoverTooltip';

interface WatcherFiredTitleProps {
  watcherFired: ChatWatcherFiredInfo;
  /**
   * `block` (the default) is the title line above a bubble's text. `inline`
   * is the leading label of a one-line queued row: the row's own text size,
   * truncating, with no line below it.
   */
  layout?: 'block' | 'inline';
}

/**
 * Title line rendered above the content of watcher-generated chat messages
 * (both queued and sent), mirroring the `hook_info` "Chat initiated by …"
 * pattern: a small broadcast icon followed by
 * "<kind> watcher has fired".
 */
export const WatcherFiredTitle = memo(function WatcherFiredTitle({
  watcherFired,
  layout = 'block',
}: WatcherFiredTitleProps): JSX.Element {
  const inline = layout === 'inline';
  const combinedWatchers = watcherFired.combinedWatchers;
  const title = combinedWatchers?.length
    ? watcherFired.kind
    : `${watcherFired.kind} watcher has fired`;
  const titleRow = (
    <span
      data-testid="watcher-fired-title"
      tabIndex={combinedWatchers?.length ? 0 : undefined}
      role={combinedWatchers?.length ? 'button' : undefined}
      className={`${
        inline
          ? 'flex min-w-0 items-center gap-1.5 fg-info'
          : 'pb-1 flex items-center gap-1.5 text-3xs font-medium fg-info'
      }${combinedWatchers?.length ? ' cursor-help' : ''}`}
    >
      <AppAdvisorWatcherIcon size="sm" className="shrink-0" />
      {/* The kind names the watched chat and project: mask it, as titles are. */}
      <span
        className={inline ? `truncate ${REPLAY_MASK_CLASS}` : REPLAY_MASK_CLASS}
      >
        {title}
      </span>
    </span>
  );

  if (!combinedWatchers?.length) return titleRow;

  return (
    <CombinedWatchersTooltip combinedWatchers={combinedWatchers}>
      {titleRow}
    </CombinedWatchersTooltip>
  );
});

/**
 * The details of several watchers delivered together: each one's kind and
 * report, opened from the trigger it wraps on hover or focus.
 */
export function CombinedWatchersTooltip({
  combinedWatchers,
  children,
}: {
  readonly combinedWatchers: NonNullable<
    ChatWatcherFiredInfo['combinedWatchers']
  >;
  readonly children: ReactElement<TooltipTriggerProps>;
}): JSX.Element {
  return (
    <RichHoverTooltip
      interactive
      dataTestId="watcher-fired-tooltip"
      surfaceClassName="w-[min(360px,calc(100vw-16px))]"
      surfacePadding="card"
      content={
        <div
          role="region"
          aria-label="Combined watcher details"
          data-rich-tooltip-autofocus
          tabIndex={0}
          className="max-h-48 grid grid-cols-1 content-start gap-2 overflow-y-auto overscroll-contain rounded-sm pr-1 focus-ring"
        >
          {combinedWatchers.map((watcher, index) => (
            <div
              key={`${watcher.kind}-${index}`}
              className="border-b line-base pb-2 last:border-b-0 last:pb-0"
            >
              <div className={`font-medium fg-info ${REPLAY_MASK_CLASS}`}>
                {watcher.kind} watcher has fired
              </div>
              <div
                className={`${REPLAY_BLOCK_CLASS} mt-0.5 whitespace-pre-wrap break-words fg-secondary`}
              >
                {watcher.text}
              </div>
            </div>
          ))}
        </div>
      }
    >
      {children}
    </RichHoverTooltip>
  );
}

/**
 * How a bubble shows a fired watcher's message: the visible notice, without
 * any instruction block the message text still carries. Only the host's own
 * marker (`watcherFired`, recorded where the host delivered the watcher)
 * earns the watcher title and the info tint; a block in the text alone could
 * have been typed by anyone, so it only loses the block. Undefined for a
 * message that is neither.
 */
export interface WatcherFiredPresentation {
  readonly text: string;
  readonly title?: JSX.Element;
  readonly variant: 'info' | 'default';
}

export function watcherFiredPresentation(
  text: string,
  layout: 'block' | 'inline' = 'block',
  watcherFired?: ChatWatcherFiredInfo,
): WatcherFiredPresentation | undefined {
  const parts = visibleMessageParts(text);
  if (parts.some((part) => part.kind === 'steering_request')) return undefined;
  const watcher = parts.find((part) => part.kind === 'watcher');
  if (watcherFired === undefined && watcher?.kind !== 'watcher') {
    return undefined;
  }
  const notice = parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n\n');
  const shown =
    notice.length > 0
      ? notice
      : watcher?.kind === 'watcher'
        ? watcher.text
        : text;
  if (watcherFired === undefined) return { text: shown, variant: 'default' };
  return {
    text: shown,
    title: <WatcherFiredTitle watcherFired={watcherFired} layout={layout} />,
    variant: 'info',
  };
}
