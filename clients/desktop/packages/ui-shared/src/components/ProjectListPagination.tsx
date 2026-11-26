'use client';

import { ControlButton } from '../primitives/Button';
import { useLayoutEffect, useRef, type JSX } from 'react';

export interface ProjectListPaginationProps {
  readonly remainingCount: number;
  readonly expanded: boolean;
  readonly onShowMore: () => void;
  readonly onShowLess: () => void;
  readonly touchTargets?: boolean;
  /**
   * Reads `More` / `Less` with no count. The accessible name keeps the full
   * description. Desktop turns it on under early access.
   */
  readonly compactLabels?: boolean;
}

/** Quiet sidebar disclosure shared by the desktop and web project lists. */
export function ProjectListPagination({
  remainingCount,
  expanded,
  onShowMore,
  onShowLess,
  touchTargets = false,
  compactLabels = false,
}: ProjectListPaginationProps): JSX.Element | null {
  const moreRef = useRef<HTMLButtonElement>(null);
  const lessRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (moreRef.current ?? lessRef.current)?.focus();
  }, [remainingCount, expanded]);
  if (remainingCount === 0 && !expanded) return null;
  // A text-only row in the project list, so the first label starts on the
  // title column the project names use. A second button on the same line
  // follows it at the ordinary padding instead of repeating the inset.

  const showMore = remainingCount > 0;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="sidebar-projects-pagination"
    >
      {showMore && (
        <ControlButton
          ref={moreRef}
          type="button"
          presentation="project-list-page"
          appearance={{ firstInRow: true, touchTargets: !!touchTargets }}
          data-testid="sidebar-projects-show-more"
          // The name starts with the visible words, so voice control finds it.
          aria-label={
            compactLabels
              ? `More: show more projects (${remainingCount} remaining)`
              : `Show more projects (${remainingCount} remaining)`
          }
          onClick={() => {
            restoreFocus.current = true;
            onShowMore();
          }}
        >
          {compactLabels ? (
            'More'
          ) : (
            <>
              Show more <span className="tabular-nums">({remainingCount})</span>
            </>
          )}
        </ControlButton>
      )}
      {expanded && (
        <ControlButton
          ref={lessRef}
          type="button"
          presentation="project-list-page"
          appearance={{ firstInRow: !showMore, touchTargets: !!touchTargets }}
          data-testid="sidebar-projects-show-less"
          aria-label={compactLabels ? 'Less: show fewer projects' : undefined}
          onClick={() => {
            restoreFocus.current = true;
            onShowLess();
          }}
        >
          {compactLabels ? 'Less' : 'Show less'}
        </ControlButton>
      )}
    </div>
  );
}
