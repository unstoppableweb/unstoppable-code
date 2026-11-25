'use client';

/**
 * PanelGridLoadingCard: what the space under a page's top bar shows while
 * its panel grid cannot mount yet, so the frame never blinks to the bare
 * page background. The shared `PanelGridSurface` shows it until the grid's
 * layout is in memory, on desktop and on the web. Desktop's inset layout
 * makes it one card, the frame the panels land in
 * (`[data-panel-grid-loading]` in the desktop `globals.css`), so the card
 * stays on screen from the moment the previous grid leaves until the next
 * one mounts; on the web, whose panel groups sit flat on the page, it is
 * that same flat area. Only its content loads: a spinner, and a label when
 * the host gives one, both held back so a quick load never flashes them.
 *
 * A wait often passes through more than one owner: the desktop chat page
 * waits for an entry's tabs, then the grid for the layout mode and the
 * layout. Each renders its own card, and the next one takes over the clock
 * of the one it replaces, so a spinner already showing stays instead of
 * hiding again for a fresh delay.
 */
import { useLayoutEffect, useState, type JSX } from 'react';
import { LOADING_PLACEHOLDER_DELAY_MS } from '../../lib/useDelayedFlag';
import { CenteredLoadingSpinner } from '../CenteredLoadingSpinner';
import { DelayedLoadingPlaceholder } from '../DelayedLoadingPlaceholder';
import { LoadingSpinner } from '../LoadingSpinner';

/** A card mounted this soon after another left continues that card's wait. */
const HANDOFF_WINDOW_MS = 100;

let cardsMounted = 0;
let waitStartedAt = 0;
let lastCardLeftAt = Number.NEGATIVE_INFINITY;

function continuesWait(now: number): boolean {
  return cardsMounted > 0 || now - lastCardLeftAt < HANDOFF_WINDOW_MS;
}

export interface PanelGridLoadingCardProps {
  /** Names what loads, under the spinner: "Loading chats…". */
  label?: string;
  testId?: string;
}

export function PanelGridLoadingCard({
  label,
  testId = 'panel-grid-loading',
}: PanelGridLoadingCardProps): JSX.Element {
  // Fixed for the mount: a delay that changed would restart the wait.
  const [delayMs] = useState(() => {
    const now = performance.now();
    return continuesWait(now)
      ? Math.max(0, LOADING_PLACEHOLDER_DELAY_MS - (now - waitStartedAt))
      : LOADING_PLACEHOLDER_DELAY_MS;
  });
  // The card it replaces leaves in the same commit, before this runs.
  useLayoutEffect(() => {
    const now = performance.now();
    if (!continuesWait(now)) waitStartedAt = now;
    cardsMounted += 1;
    return (): void => {
      cardsMounted -= 1;
      lastCardLeftAt = performance.now();
    };
  }, []);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      data-panel-grid-loading
      data-testid={testId}
    >
      <DelayedLoadingPlaceholder className="flex-1" delayMs={delayMs}>
        {label === undefined ? (
          <CenteredLoadingSpinner />
        ) : (
          <div
            role="status"
            className="flex min-h-full flex-1 flex-col items-center justify-center gap-3 fg-secondary"
          >
            {/* The label under it is what gets announced. */}
            <LoadingSpinner tone="secondary" decorative />
            <span className="text-s">{label}</span>
          </div>
        )}
      </DelayedLoadingPlaceholder>
    </div>
  );
}
