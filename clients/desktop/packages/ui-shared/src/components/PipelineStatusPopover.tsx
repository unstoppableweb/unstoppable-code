import { type StatusGlyphState } from '../lib/status-glyph';
import { StatusGlyph } from './StatusGlyph';
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { BADGE_HOVER_CARD_SURFACE } from './ChatPreviewPopover';
import { RichHoverCard } from './RichHoverTooltip';
import { Stack } from './Stack';
import type { WorktreePipelineStatus } from './WorktreeRow';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { formatElapsed, getElapsedMs } from '../lib/pipeline-timing-display';

export interface PipelineStatusPopoverEntry {
  id: string;
  name: string;
  status:
    | 'pending'
    | 'running'
    | 'paused'
    | 'success'
    | 'failure'
    | 'cancelled';
  startedAt?: string;
  completedAt?: string;
  /**
   * ISO instant the whole run entered its current pause. Present only while
   * the run is paused; it freezes the displayed duration at that instant.
   */
  pausedAt?: string;
  /** Milliseconds already spent in earlier, closed whole-run pauses. */
  pausedMs?: number;
  runningJobs?: string[];
  failedJobs?: string[];
}

function pipelineStatusDisplayLabel(status: WorktreePipelineStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'unseen-failure':
      return 'Failed';
    case 'unseen':
      return 'Completed';
    case 'paused':
      return 'Paused';
  }
}

const PIPELINE_ENTRY_GLYPH: Readonly<
  Record<PipelineStatusPopoverEntry['status'], StatusGlyphState>
> = {
  pending: 'queued',
  running: 'running',
  paused: 'paused',
  success: 'done',
  failure: 'failed',
  cancelled: 'cancelled',
};

function pipelineEntryStatusLabel(
  status: PipelineStatusPopoverEntry['status'],
): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'success':
      return 'Success';
    case 'failure':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

function pipelineEntryStatusColor(
  status: PipelineStatusPopoverEntry['status'],
): string {
  switch (status) {
    case 'pending':
    case 'running':
      return OPERATIONAL_STATUS_COLORS.active.foreground;
    case 'paused':
      return OPERATIONAL_STATUS_COLORS.paused.foreground;
    case 'success':
      return OPERATIONAL_STATUS_COLORS.success.foreground;
    case 'failure':
      return OPERATIONAL_STATUS_COLORS.failed.foreground;
    case 'cancelled':
      return OPERATIONAL_STATUS_COLORS.paused.foreground;
  }
}

/**
 * Entry rows kept fully visible before the list becomes a scroll region. A
 * worktree can accumulate an unbounded number of unseen runs, so the popover
 * grows to roughly three rows and then scrolls instead of running off-screen.
 */
const MAX_VISIBLE_ENTRIES = 3;

/**
 * Grace period hosts should wait before tearing the popover down after the
 * pointer leaves the badge, so it can travel the gap into a scrollable list.
 */
export const PIPELINE_POPOVER_HIDE_DELAY_MS = 160;

export interface PipelineStatusPopoverProps {
  anchorRect: DOMRect;
  entries: PipelineStatusPopoverEntry[];
  status: WorktreePipelineStatus;
  /** Stable target used by the host badge's keyboard navigation. */
  listId?: string;
  /**
   * Fired when the pointer enters the scrollable entry list. Hosts cancel
   * their pending hide here so the list stays open long enough to scroll.
   * Only fires while the list is actually scrollable — a short list keeps the
   * popover fully click-through.
   */
  onListMouseEnter?: () => void;
  /** Fired when the pointer leaves the scrollable entry list. */
  onListMouseLeave?: () => void;
  /** Fired when keyboard focus enters the scrollable entry list. */
  onListFocus?: () => void;
  /** Fired when keyboard focus leaves the scrollable entry list. */
  onListBlur?: () => void;
  /** Dismisses the list and returns keyboard focus to its controlling badge. */
  onListDismiss?: () => void;
  /** Reports when the measured scroll region is ready to receive focus. */
  onScrollableListReady?: (list: HTMLDivElement) => void;
}

export function PipelineStatusPopover({
  anchorRect,
  entries,
  status,
  listId,
  onListMouseEnter,
  onListMouseLeave,
  onListFocus,
  onListBlur,
  onListDismiss,
  onScrollableListReady,
}: PipelineStatusPopoverProps): JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null);
  const wasScrollableRef = useRef(false);
  const listHasFocusRef = useRef(false);
  const onListBlurRef = useRef(onListBlur);
  onListBlurRef.current = onListBlur;
  const [listMaxHeight, setListMaxHeight] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  const hasActiveEntry = entries.some(
    (e) => e.status === 'running' || e.status === 'pending',
  );

  useEffect((): (() => void) | undefined => {
    if (!hasActiveEntry) return undefined;
    const interval = window.setInterval((): void => {
      setNowMs(Date.now());
    }, 1000);
    return (): void => {
      window.clearInterval(interval);
    };
  }, [hasActiveEntry]);

  // Entry rows are variable height (the runtime and job lines are
  // conditional), so the scroll bound is measured off the rendered rows rather
  // than assumed from a fixed row height. The card re-places itself when the
  // clamp changes its height.
  useLayoutEffect((): void => {
    const list = listRef.current;
    if (!list || entries.length <= MAX_VISIBLE_ENTRIES) {
      setListMaxHeight(null);
      return;
    }

    const firstRow = list.children[0];
    const lastVisibleRow = list.children[MAX_VISIBLE_ENTRIES - 1];
    if (
      !(firstRow instanceof HTMLElement) ||
      !(lastVisibleRow instanceof HTMLElement)
    ) {
      setListMaxHeight(null);
      return;
    }

    const measured =
      lastVisibleRow.getBoundingClientRect().bottom -
      firstRow.getBoundingClientRect().top;
    // A zero measurement means the rows have no layout yet (jsdom, or a
    // display:none ancestor); leaving the list unclamped beats collapsing it.
    setListMaxHeight(measured > 0 ? measured : null);
  }, [entries]);

  const statusLabel = pipelineStatusDisplayLabel(status);
  const isScrollable = listMaxHeight !== null;

  useEffect((): void => {
    const list = listRef.current;
    if (
      wasScrollableRef.current &&
      !isScrollable &&
      list?.contains(document.activeElement)
    ) {
      listHasFocusRef.current = false;
      onListBlur?.();
    }
    wasScrollableRef.current = isScrollable;
  }, [isScrollable, onListBlur]);

  useEffect(
    (): (() => void) => () => {
      if (listHasFocusRef.current) {
        listHasFocusRef.current = false;
        onListBlurRef.current?.();
      }
    },
    [],
  );

  useLayoutEffect((): void => {
    if (isScrollable && listRef.current) {
      onScrollableListReady?.(listRef.current);
    }
  }, [isScrollable, onScrollableListReady]);

  return (
    <RichHoverCard
      anchorRect={anchorRect}
      dataTestId="pipeline-status-popover"
      {...BADGE_HOVER_CARD_SURFACE}
      surfaceClassName="min-w-40 max-w-65"
    >
      <Stack gap="tight">
        {/* Header stays put; only the entry list below it scrolls. */}
        <div
          className="text-3xs font-semibold fg-secondary"
          data-testid="pipeline-status-popover-header"
        >
          {entries.length > 0
            ? `Workflows ${statusLabel} (${String(entries.length)})`
            : `Workflows ${statusLabel}`}
        </div>
        {entries.length === 0 ? (
          <div id={listId} className="text-xs fg-secondary">
            No workflow details
          </div>
        ) : (
          <div
            ref={listRef}
            id={listId}
            data-testid="pipeline-status-popover-list"
            data-scrollable={isScrollable ? 'true' : 'false'}
            aria-label={isScrollable ? 'Workflow runs' : undefined}
            tabIndex={isScrollable ? 0 : undefined}
            className={`grid grid-cols-1 content-start gap-1.5${
              isScrollable ? ' pointer-events-auto overflow-y-auto pr-1' : ''
            }`}
            style={isScrollable ? { maxHeight: listMaxHeight } : undefined}
            onMouseEnter={isScrollable ? onListMouseEnter : undefined}
            onMouseLeave={isScrollable ? onListMouseLeave : undefined}
            onPointerDown={
              isScrollable
                ? (event): void => event.stopPropagation()
                : undefined
            }
            onClick={
              isScrollable
                ? (event): void => event.stopPropagation()
                : undefined
            }
            onContextMenu={
              isScrollable
                ? (event): void => event.stopPropagation()
                : undefined
            }
            onFocus={(): void => {
              listHasFocusRef.current = true;
              onListFocus?.();
            }}
            onBlur={(): void => {
              listHasFocusRef.current = false;
              onListBlur?.();
            }}
            onKeyDown={
              isScrollable
                ? (event): void => {
                    if (event.key !== 'Escape' && event.key !== 'ArrowUp')
                      return;
                    event.preventDefault();
                    onListDismiss?.();
                  }
                : undefined
            }
          >
            {entries.map((entry) => {
              const elapsed = getElapsedMs({
                startedAt: entry.startedAt,
                completedAt: entry.completedAt,
                pausedAt: entry.pausedAt,
                pausedMs: entry.pausedMs,
                nowMs,
              });
              const runtime =
                elapsed !== null ? formatElapsed(elapsed) : undefined;

              return (
                <div key={entry.id}>
                  <div className="flex items-center gap-1.5 text-xs">
                    <StatusGlyph
                      state={PIPELINE_ENTRY_GLYPH[entry.status]}
                      size={12}
                    />
                    <span className="truncate fg-primary" title={entry.name}>
                      {entry.name}
                    </span>
                    <span
                      className={`ml-auto shrink-0 ${pipelineEntryStatusColor(entry.status)}`}
                    >
                      {pipelineEntryStatusLabel(entry.status)}
                    </span>
                  </div>
                  {(runtime ||
                    (entry.runningJobs && entry.runningJobs.length > 0) ||
                    (entry.failedJobs && entry.failedJobs.length > 0)) && (
                    <div className="pl-3 mt-0.5 flex flex-col gap-px">
                      {runtime && (
                        <div className="text-3xs tabular-nums fg-secondary">
                          {runtime}
                        </div>
                      )}
                      {entry.runningJobs && entry.runningJobs.length > 0 && (
                        <div
                          className={`text-pretty break-words text-3xs ${OPERATIONAL_STATUS_COLORS.active.foregroundMuted}`}
                        >
                          Running: {entry.runningJobs.join(', ')}
                        </div>
                      )}
                      {entry.failedJobs && entry.failedJobs.length > 0 && (
                        <div
                          className={`text-pretty break-words text-3xs ${OPERATIONAL_STATUS_COLORS.failed.foregroundMuted}`}
                        >
                          Failed: {entry.failedJobs.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Stack>
    </RichHoverCard>
  );
}
