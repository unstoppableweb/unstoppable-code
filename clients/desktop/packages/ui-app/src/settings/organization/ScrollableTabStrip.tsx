'use client';

import {
  ScrollableTabFrame,
  type ScrollableTabFrameVariant,
} from '@canopy/ui-shared/components';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

/** The outer frame: `underline` for a page-level strip with a bottom border. */
export type ScrollableTabStripFrame = ScrollableTabFrameVariant;

interface ScrollableTabStripProps {
  /** The tab `<nav>` (or equivalent) rendered inside the scroll container. */
  children: ReactNode;
  /** The outer frame treatment. */
  frame?: ScrollableTabStripFrame;
  /**
   * Classes applied to the outer frame, for web callers outside the shared
   * packages. Shared code picks a {@link frame} instead.
   */
  className?: string;
  /** Classes applied to the inner `overflow-x-auto` scroll container. */
  contentClassName?: string;
}

interface EdgeState {
  start: boolean;
  end: boolean;
}

const FADE_SIZE = '24px';

/**
 * Reusable horizontal scroll wrapper for tab strips that run out of room on
 * narrow (mobile) widths. Instead of wrapping to a second line, the tabs stay
 * on one line inside an `overflow-x-auto` container and the user drags/scrolls
 * to reach the overflow. A theme-independent `mask-image` gradient fades the
 * edge that can still be scrolled so the overflow is discoverable. The mask
 * never blocks pointer events, so tabs remain clickable.
 */
export function ScrollableTabStrip({
  children,
  frame,
  className,
  contentClassName,
}: ScrollableTabStripProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<EdgeState>({ start: false, end: false });

  const updateEdges = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);

  useLayoutEffect(() => {
    updateEdges();
  }, [updateEdges]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => updateEdges());
    observer.observe(el);
    // Also observe the scrolling content so edge state updates whenever the tab
    // strip's intrinsic width changes without the container resizing — e.g. tabs
    // are added/removed based on permissions, labels change, or web fonts load.
    const content = el.firstElementChild;
    if (content) {
      observer.observe(content);
    }
    return (): void => observer.disconnect();
  }, [updateEdges]);

  let maskImage: string | undefined;
  if (edges.start && edges.end) {
    maskImage = `linear-gradient(to right, transparent, black ${FADE_SIZE}, black calc(100% - ${FADE_SIZE}), transparent)`;
  } else if (edges.start) {
    maskImage = `linear-gradient(to right, transparent, black ${FADE_SIZE})`;
  } else if (edges.end) {
    maskImage = `linear-gradient(to right, black calc(100% - ${FADE_SIZE}), transparent)`;
  }

  // `pb-px` on the scroll container reserves 1px below the content so tab
  // underlines that use a `-mb-px` overlap against the outer border are not
  // clipped by `overflow-x-auto` (which computes `overflow-y` to `auto`).
  const strip = (
    <div
      ref={scrollRef}
      onScroll={updateEdges}
      className={`overflow-x-auto pb-px scrollbar-hide ${contentClassName ?? ''}`}
      style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
    >
      {children}
    </div>
  );
  return frame === undefined ? (
    <div className={className}>{strip}</div>
  ) : (
    <ScrollableTabFrame variant={frame}>{strip}</ScrollableTabFrame>
  );
}
