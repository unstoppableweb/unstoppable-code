'use client';

import {
  type ForwardedRef,
  type HTMLAttributes,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useScrollbarBehavior } from '../lib/useAlwaysVisibleScrollbars';

/**
 * The viewport's role. `menu` is a floating menu's row viewport: it fills
 * the surface's grid cell, clips horizontally, contains overscroll, and
 * rounds to the surface's inner radius. `pickerList` is a picker's option
 * list, which keeps the containment and radius and leaves the rest of the
 * anatomy to the picker. `drawer` is a drawer card's row list, 4px inside
 * the card: it rounds to the drawer rows' corner (`--radius-drawer-row`),
 * so a row cut by its edge while scrolling keeps a row's corner, nested in
 * the card's, instead of a square one.
 */
export type OverlayScrollAreaViewport =
  | 'plain'
  | 'menu'
  | 'pickerList'
  | 'drawer';

const VIEWPORT_CLASS_NAMES: Record<OverlayScrollAreaViewport, string> = {
  plain: '',
  menu: 'canopy-floating-menu-scroll-viewport',
  pickerList: 'canopy-picker-menu-list',
  drawer: 'overflow-x-hidden overscroll-contain rounded-drawer-row',
};

/**
 * 4px of breathing room above the first and below the last row, carried by
 * the scroll content so rows scroll under the surface's rounded corners
 * instead of parking a band of surface color under a mid-clipped row. A
 * footerless picker drops the bottom 4px (see canopy-tokens.css).
 */
const CONTENT_INSET_CLASS_NAMES: Record<OverlayScrollAreaViewport, string> = {
  plain: '',
  menu: 'canopy-floating-menu-scroll-content',
  pickerList: 'canopy-picker-menu-list-content',
  drawer: '',
};

export interface OverlayScrollAreaProps {
  readonly children: ReactNode;
  /** Classes for the positioning wrapper (owns `relative`). */
  readonly className?: string;
  readonly viewport?: OverlayScrollAreaViewport;
  /** Classes for the scrollable viewport (native scrollbar hidden). */
  readonly viewportClassName?: string;
  /** With a `menu` or `pickerList` viewport, the row inset described above. */
  readonly contentInset?: boolean;
  /**
   * Extra props spread onto the viewport element (role, aria, ids, and
   * `data-*` hooks callers position or query against).
   */
  readonly viewportProps?: HTMLAttributes<HTMLDivElement> &
    Record<`data-${string}`, string>;
  /** Forwarded ref to the scrollable viewport element. */
  readonly viewportRef?: ForwardedRef<HTMLDivElement>;
  readonly contentClassName?: string;
  /**
   * Positioning classes for the scrollbar rail (default `right-0`). Hosts
   * whose wrapper is inset from the visual surface (e.g. a padded menu) pass
   * a negative offset so the thumb aligns to the surface edge instead.
   */
  readonly railClassName?: string;
  /** Space reserved at both ends of the scrollbar track. */
  readonly thumbEndInset?: number;
  /** Fade content at edges where more scrollable content remains. */
  readonly edgeFadeSize?: number;
  /**
   * Which edges `edgeFadeSize` fades. `bottom` leaves the top edge sharp, for
   * a surface whose top carries pinned content (the chat transcript's stuck
   * user bubble) and whose bottom meets another surface (the composer).
   */
  readonly edgeFadeEdges?: 'both' | 'bottom';
  /**
   * The top fade's length when it should differ from `edgeFadeSize`: a list
   * under a header can fade in early at the top while its bottom stays crisp
   * against the next surface.
   */
  readonly edgeFadeTopSize?: number;
  /**
   * A fully clear band at the bottom edge, below the bottom fade: rows are
   * gone before they reach the surface underneath. Defaults to 0.
   */
  readonly edgeFadeBottomInset?: number;
  /**
   * Height of content pinned to the viewport top (a sticky table header).
   * The top fade starts below it, so the pinned content stays sharp and the
   * rows scrolling under it fade instead.
   */
  readonly edgeFadeTopInset?: number;
  /**
   * Whether content changes are detected with a subtree MutationObserver in
   * addition to the ResizeObserver. Hosts whose content height always changes
   * with its DOM (the chat transcript, which streams tokens on the renderer's
   * hottest path) pass `false`: the ResizeObserver on the content element
   * already catches every growth, and the observer would otherwise fire on
   * each streamed token.
   */
  readonly observeMutations?: boolean;
}

interface DragState {
  readonly pointerId: number;
  readonly startClientY: number;
  readonly startScrollTop: number;
}

const EDGE_TOLERANCE_PX = 1;
const MIN_THUMB_HEIGHT_PX = 24;
/**
 * Gap kept between the thumb's ends and the track's, matching the >=2px inset
 * the thumb already keeps from the edge it rides against. Without it the thumb
 * butted flush into the section's top and bottom edges at the scroll extremes.
 */
const THUMB_END_INSET_PX = 2;

/**
 * How long the scrollbar stays visible after the last scroll, rail hover, or
 * thumb drag before fading out (Radix ScrollArea default; VS Code uses 500ms).
 */
export const OVERLAY_SCROLLBAR_HIDE_DELAY_MS = 600;

/**
 * Scroll viewport with an absolutely positioned overlay scrollbar (the
 * desktop sidebar's convention, shared so menus/pickers can reuse it): the
 * native scrollbar is hidden and never participates in layout, so content
 * keeps symmetric insets; the custom 6px thumb rides 2px in from the right
 * edge, revealed by direct wheel/trackpad scrolling and pinned while hovered
 * or dragged, then fades after the idle delay. Programmatic scrolls
 * (scrollIntoView, keyboard-driven repositioning) stay silent.
 */
export function OverlayScrollArea({
  children,
  className = '',
  viewport = 'plain',
  viewportClassName = '',
  viewportProps,
  viewportRef: forwardedViewportRef,
  contentInset = false,
  contentClassName = '',
  railClassName = 'right-0',
  thumbEndInset = THUMB_END_INSET_PX,
  edgeFadeSize = 0,
  edgeFadeEdges = 'both',
  edgeFadeTopSize,
  edgeFadeBottomInset = 0,
  edgeFadeTopInset = 0,
  observeMutations = true,
}: OverlayScrollAreaProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const railHoverRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const isRevealedRef = useRef(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const scrollbarBehavior = useScrollbarBehavior(viewportRef);
  const isVisible =
    hasOverflow &&
    (scrollbarBehavior === 'always' ||
      (scrollbarBehavior === 'scroll' && isRevealed) ||
      (scrollbarBehavior === 'hover' && isHovered));

  const attachViewport = useCallback(
    (node: HTMLDivElement | null): void => {
      viewportRef.current = node;
      if (typeof forwardedViewportRef === 'function') {
        forwardedViewportRef(node);
      } else if (forwardedViewportRef) {
        forwardedViewportRef.current = node;
      }
    },
    [forwardedViewportRef],
  );

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback((): void => {
    clearHideTimer();
    if (railHoverRef.current || dragRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      isRevealedRef.current = false;
      setIsRevealed(false);
    }, OVERLAY_SCROLLBAR_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const reveal = useCallback((): void => {
    isRevealedRef.current = true;
    setIsRevealed(true);
    scheduleHide();
  }, [scheduleHide]);

  const updateRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    // The mask this effect last wrote. The update runs on every scroll frame
    // (the chat transcript's included), so the style is written only when
    // the fade actually changes; the browser's serialization of an inline
    // gradient does not round-trip, so it cannot be compared instead.
    let paintedMask: string | null = null;
    updateRef.current = (): void => {
      const viewport = viewportRef.current;
      const thumb = thumbRef.current;
      if (!viewport || !thumb) return;

      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      const overflow = maxScrollTop > EDGE_TOLERANCE_PX;
      setHasOverflow(overflow);
      if (edgeFadeSize > 0) {
        const top =
          edgeFadeEdges === 'both' &&
          overflow &&
          viewport.scrollTop > EDGE_TOLERANCE_PX;
        const bottom =
          overflow && maxScrollTop - viewport.scrollTop > EDGE_TOLERANCE_PX;
        const topFade = edgeFadeTopSize ?? edgeFadeSize;
        const topStops =
          edgeFadeTopInset > 0
            ? `black ${edgeFadeTopInset}px, ${top ? 'transparent' : 'black'} ${edgeFadeTopInset}px, black ${edgeFadeTopInset + (top ? topFade : 0)}px`
            : `${top ? 'transparent' : 'black'}, black ${top ? topFade : 0}px`;
        const mask =
          top || bottom
            ? `linear-gradient(to bottom, ${topStops}, black calc(100% - ${bottom ? edgeFadeSize + edgeFadeBottomInset : 0}px), ${bottom ? `transparent calc(100% - ${edgeFadeBottomInset}px), transparent` : 'black'})`
            : 'none';
        if (paintedMask !== mask) {
          viewport.style.maskImage = mask;
          paintedMask = mask;
        }
      }
      if (!overflow) {
        clearHideTimer();
        isRevealedRef.current = false;
        setIsRevealed(false);
        return;
      }

      // Track geometry comes from the painted box, not `clientHeight`:
      // the latter is rounded to an integer, and on a fractional layout
      // (a 1098.5px viewport reporting 1099) that rounding ate ~1px of the
      // bottom inset at full scroll.
      const paintedHeight = viewport.getBoundingClientRect().height;
      const trackHeight = Math.max(0, paintedHeight - thumbEndInset * 2);
      const thumbHeight = Math.min(
        trackHeight,
        Math.max(
          MIN_THUMB_HEIGHT_PX,
          (paintedHeight / viewport.scrollHeight) * trackHeight,
        ),
      );
      const maxThumbTop = trackHeight - thumbHeight;
      // Clamp: `maxScrollTop` derives from the rounded `clientHeight`, so a
      // fractional viewport lets `scrollTop` run slightly past it at the
      // extreme, which would otherwise push the thumb past its inset.
      const scrollProgress =
        maxScrollTop > 0
          ? Math.min(1, Math.max(0, viewport.scrollTop / maxScrollTop))
          : 0;
      const thumbTop = thumbEndInset + scrollProgress * maxThumbTop;

      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${thumbTop}px)`;
    };
    // A caller may own a custom mask when the shared edge fade is disabled.
    // Only clear a mask we painted, including when edgeFadeSize becomes zero.
    const viewport = viewportRef.current;
    return (): void => {
      if (edgeFadeSize > 0 && viewport) viewport.style.maskImage = 'none';
    };
  }, [
    clearHideTimer,
    thumbEndInset,
    edgeFadeSize,
    edgeFadeEdges,
    edgeFadeTopSize,
    edgeFadeBottomInset,
    edgeFadeTopInset,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport) return undefined;

    const view = viewport.ownerDocument.defaultView;
    let layoutFrameId: number | null = null;
    const scheduleLayout = (): void => {
      if (!view || typeof view.requestAnimationFrame !== 'function') {
        updateRef.current();
        return;
      }
      if (layoutFrameId !== null) return;
      layoutFrameId = view.requestAnimationFrame(() => {
        layoutFrameId = null;
        updateRef.current();
      });
    };
    const resizeObserver =
      view && 'ResizeObserver' in view
        ? new view.ResizeObserver(scheduleLayout)
        : null;
    const mutationObserver =
      observeMutations && view && 'MutationObserver' in view
        ? new view.MutationObserver(scheduleLayout)
        : null;

    resizeObserver?.observe(viewport);
    if (content) {
      resizeObserver?.observe(content);
    }
    mutationObserver?.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const handleWheel = (): void => {
      if (viewport.scrollHeight - viewport.clientHeight > EDGE_TOLERANCE_PX) {
        reveal();
      }
    };
    viewport.addEventListener('wheel', handleWheel, { passive: true });
    const rail = railRef.current;
    const handleRailPointerEnter = (): void => {
      railHoverRef.current = true;
      if (isRevealedRef.current) {
        reveal();
      }
    };
    const handleRailPointerLeave = (): void => {
      railHoverRef.current = false;
      if (isRevealedRef.current) {
        scheduleHide();
      }
    };
    rail?.addEventListener('pointerenter', handleRailPointerEnter);
    rail?.addEventListener('pointerleave', handleRailPointerLeave);
    updateRef.current();
    scheduleLayout();

    return (): void => {
      viewport.removeEventListener('wheel', handleWheel);
      rail?.removeEventListener('pointerenter', handleRailPointerEnter);
      rail?.removeEventListener('pointerleave', handleRailPointerLeave);
      clearHideTimer();
      if (layoutFrameId !== null && view) {
        view.cancelAnimationFrame(layoutFrameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [clearHideTimer, observeMutations, reveal, scheduleHide]);

  const handleThumbPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startScrollTop: viewport.scrollTop,
    };
    reveal();
  };

  const handleThumbPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;

    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const thumbHeight = thumbRef.current?.offsetHeight ?? 0;
    const availableTrack =
      viewport.getBoundingClientRect().height - thumbEndInset * 2 - thumbHeight;
    if (availableTrack <= 0) return;

    viewport.scrollTop =
      drag.startScrollTop +
      ((event.clientY - drag.startClientY) / availableTrack) * maxScrollTop;
  };

  const endThumbDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scheduleHide();
  };

  const viewportRoleClassName =
    viewport === 'plain' ? '' : ` ${VIEWPORT_CLASS_NAMES[viewport]}`;
  const resolvedContentClassName = [
    contentInset ? CONTENT_INSET_CLASS_NAMES[viewport] : '',
    contentClassName,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    // Flex (not percentage) heights: the host surface is often only
    // max-height-capped (indefinite), where `height: 100%` cannot resolve —
    // the viewport is a shrinkable flex item instead.
    <div
      // Position comes from a zero-specificity `:where([data-overlay-scroll-area])`
      // rule, NOT a `relative` utility here: Tailwind emits `.relative` after
      // `.absolute`, so a hard-coded `relative` silently beat any caller
      // passing `absolute inset-0` — the wrapper then grew to content height
      // and the surface stopped scrolling entirely.
      className={`flex min-h-0 flex-col ${className}`}
      data-overlay-scroll-area=""
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
    >
      <div
        {...viewportProps}
        ref={attachViewport}
        className={`scrollbar-hide min-h-0 flex-1 overflow-y-auto${viewportRoleClassName} ${viewportClassName}`}
        onScroll={(event) => {
          updateRef.current();
          viewportProps?.onScroll?.(event);
        }}
      >
        <div
          ref={contentRef}
          className={resolvedContentClassName}
          data-overlay-scroll-content=""
        >
          {children}
        </div>
      </div>
      <div
        ref={railRef}
        aria-hidden="true"
        // A shrinking viewport can briefly retain the old thumb geometry.
        // Clip it so invisible overflow cannot inflate an ancestor menu's size.
        className={`absolute inset-y-0 z-10 overflow-hidden ${railClassName} ${
          isVisible
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        }`}
        data-overlay-scrollbar=""
      >
        <div
          ref={thumbRef}
          className={`absolute top-0 touch-none rounded-full bg-fg-quaternary/50 ${
            isVisible ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
          data-overlay-scrollbar-thumb=""
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={endThumbDrag}
          onPointerCancel={endThumbDrag}
          onLostPointerCapture={endThumbDrag}
        />
      </div>
    </div>
  );
}
