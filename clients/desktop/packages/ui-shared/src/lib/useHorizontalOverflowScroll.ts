'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useScrollbarBehavior } from './useAlwaysVisibleScrollbars';

/**
 * Wheel panning + overflow feedback for a horizontally scrollable strip (tab
 * bars, session-tab lists). Returns a ref for the scroll container, two
 * booleans for edge fade/shadow overlays, a ref for a custom overlay
 * scrollbar thumb, and whether the strip currently overflows.
 *
 * - Vertical wheel deltas pan the strip horizontally (a plain mouse wheel can
 *   scroll it); attached imperatively with `{ passive: false }` since React's
 *   synthetic `onWheel` is passive. Native horizontal deltas are left alone.
 * - `showStartFade`/`showEndFade` drive the edge shadow overlays: state, so
 *   they only flip at an edge (`setState` bails otherwise).
 * - `thumbRef`/`hasOverflow` drive a VS-Code-style overlay scrollbar: the
 *   thumb's width/position track the visible fraction and scroll offset and
 *   are written IMPERATIVELY on every scroll frame (no re-render); the caller
 *   renders the thumb absolutely-positioned at the strip's bottom edge and
 *   reveals it on hover via CSS. `hasOverflow` (state) gates whether the
 *   thumb is shown at all.
 * - Everything updates on scroll, element resize, and content mutation using
 *   observers from the element's own window (so it works in pulled-out panel
 *   windows). Content observation catches tab add/remove/title changes that
 *   alter `scrollWidth` without resizing the element.
 * - Listeners follow the element across conditional (re)mounts: they are bound
 *   whenever the referenced node's identity changes, not once at mount. A strip
 *   that only renders after the first commit — e.g. the pinned-tabs strip that
 *   appears when the first tab is pinned — still gets wired up. `ref` stays a
 *   stable `RefObject` so consumers can also read `ref.current` imperatively.
 */
export interface HorizontalOverflowScroll<T extends HTMLElement> {
  readonly ref: RefObject<T | null>;
  /** Last observer/listener measurement; null until the strip is measured. */
  readonly overflowRef: RefObject<boolean | null>;
  readonly showStartFade: boolean;
  readonly showEndFade: boolean;
  readonly thumbRef: RefObject<HTMLDivElement | null>;
  readonly hasOverflow: boolean;
  /**
   * Whether the overlay scrollbar is currently revealed. Mirrors the sidebar's
   * convention (see `OverlayScrollArea`): direct wheel/trackpad input reveals
   * it, hovering the thumb or dragging pins it, and it fades after the idle
   * delay. Programmatic scrolls (scrollIntoView) stay silent.
   */
  readonly isScrollbarRevealed: boolean;
  /**
   * Optional hit zone along the strip's bottom edge, for a strip whose thumb
   * is a thin line (fill tab rows). While the pointer is over it the bar
   * stays revealed and `isScrollbarActive` is true (the caller grows the
   * line); pressing the thumb drags it from the grab point, pressing the
   * track beside it jumps there and keeps dragging. Callers that render no
   * track keep the thumb's own pointer handling.
   */
  readonly trackRef: RefObject<HTMLDivElement | null>;
  /** The track is hovered or the thumb is being dragged. */
  readonly isScrollbarActive: boolean;
}

// Sub-pixel rounding slack so a fully-scrolled edge reports no overflow.
const EDGE_TOLERANCE_PX = 1;
// Smallest thumb so it stays visible/grabbable under heavy overflow.
const MIN_THUMB_WIDTH_PX = 24;
/** Idle delay before the revealed scrollbar fades (sidebar parity). */
const SCROLLBAR_HIDE_DELAY_MS = 600;
/** Matches the thumb's CSS `left`/`bottom` inset from the strip's edges. */
const THUMB_EDGE_INSET_PX = 2;
/**
 * How long the pointer must rest on the thin-line track before the line
 * shows, so moving across the tabs never makes it blink.
 */
export const SCROLL_TRACK_HOVER_DELAY_MS = 250;

export function useHorizontalOverflowScroll<
  T extends HTMLElement,
>(): HorizontalOverflowScroll<T> {
  const ref = useRef<T | null>(null);
  const overflowRef = useRef<boolean | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const [showStartFade, setShowStartFade] = useState(false);
  const [showEndFade, setShowEndFade] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [isScrollbarRevealed, setIsScrollbarRevealed] = useState(false);
  const [isScrollAreaHovered, setIsScrollAreaHovered] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [isTrackHovered, setIsTrackHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const scrollbarBehavior = useScrollbarBehavior(ref);
  const revealedRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const thumbHoverRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
  } | null>(null);

  const clearHideTimer = (): void => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const scheduleHide = (): void => {
    clearHideTimer();
    if (thumbHoverRef.current || dragRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      revealedRef.current = false;
      setIsScrollbarRevealed(false);
    }, SCROLLBAR_HIDE_DELAY_MS);
  };

  const reveal = (): void => {
    revealedRef.current = true;
    setIsScrollbarRevealed(true);
    scheduleHide();
  };

  const updateRef = useRef<() => void>(() => {});
  updateRef.current = (): void => {
    const el = ref.current;
    if (!el) {
      overflowRef.current = null;
      return;
    }
    const maxScrollLeft = el.scrollWidth - el.clientWidth;
    const overflow = maxScrollLeft > EDGE_TOLERANCE_PX;
    overflowRef.current = overflow;
    setShowStartFade(el.scrollLeft > EDGE_TOLERANCE_PX);
    setShowEndFade(el.scrollLeft < maxScrollLeft - EDGE_TOLERANCE_PX);
    setHasOverflow(overflow);
    if (!overflow) {
      // Retire a lingering reveal (and its timer) so the bar cannot resurrect
      // without new input if overflow returns within the hide delay.
      clearHideTimer();
      revealedRef.current = false;
      setIsScrollbarRevealed(false);
    }

    // Position the overlay scrollbar thumb imperatively (no re-render): width
    // = visible fraction of the content, offset = scroll position along the
    // track. `left: 0` + translateX keeps min-width clamping correct.
    const thumb = thumbRef.current;
    if (thumb && overflow) {
      // The track is inset by the thumb's 2px edge offset on BOTH ends so the
      // bar never runs flush into the strip's corners.
      const trackWidth = el.clientWidth - THUMB_EDGE_INSET_PX * 2;
      const thumbWidth = Math.max(
        MIN_THUMB_WIDTH_PX,
        (el.clientWidth / el.scrollWidth) * trackWidth,
      );
      const maxThumbLeft = trackWidth - thumbWidth;
      const thumbLeft =
        maxScrollLeft > 0 ? (el.scrollLeft / maxScrollLeft) * maxThumbLeft : 0;
      thumb.style.width = `${thumbWidth}px`;
      thumb.style.transform = `translateX(${thumbLeft}px)`;
    }
  };

  // The node the listeners are currently bound to, plus their teardown. Tracked
  // in refs (not derived from a one-shot mount effect) so binding can follow the
  // element across conditional (re)mounts.
  const boundNodeRef = useRef<T | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const bindListeners = (el: T): void => {
    const update = (): void => updateRef.current();

    const handleWheel = (event: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth) {
        return;
      }
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const nextScrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, el.scrollLeft + event.deltaY),
      );
      if (nextScrollLeft === el.scrollLeft) {
        return;
      }
      event.preventDefault();
      el.scrollLeft = nextScrollLeft;
    };

    // Only direct user input reveals the bar (sidebar parity): wheel/trackpad
    // over the strip, or a pointer interaction with the thumb itself.
    const handleWheelReveal = (): void => {
      if (el.scrollWidth - el.clientWidth > EDGE_TOLERANCE_PX) reveal();
    };

    const handleScrollAreaEnter = (): void => setIsScrollAreaHovered(true);
    const handleScrollAreaLeave = (): void => setIsScrollAreaHovered(false);
    // The custom thumb is an absolutely positioned sibling of the native
    // scrolling strip. Observe their shared wrapper so moving from the strip
    // onto the thumb remains inside one hover boundary.
    const hoverTarget = el.parentElement ?? el;

    const thumb = thumbRef.current;
    const handleThumbEnter = (): void => {
      thumbHoverRef.current = true;
      if (revealedRef.current) reveal();
    };
    const handleThumbLeave = (): void => {
      thumbHoverRef.current = false;
      if (revealedRef.current) scheduleHide();
    };
    const handleThumbPointerDown = (event: PointerEvent): void => {
      if (!thumb) return;
      event.preventDefault();
      event.stopPropagation();
      thumb.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: el.scrollLeft,
      };
      reveal();
    };
    // Scroll distance per pixel of thumb travel: the scroll range over the
    // room the thumb can move in (the inset track less the thumb).
    const scrollPerPixel = (): number => {
      if (!thumb) return 0;
      const travel =
        el.clientWidth - THUMB_EDGE_INSET_PX * 2 - thumb.offsetWidth;
      return travel > 0 ? (el.scrollWidth - el.clientWidth) / travel : 0;
    };
    const dragTo = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      // Instant (no smooth-scroll easing) and clamped at both ends, so the
      // thumb stays under the grab point.
      el.style.scrollBehavior = 'auto';
      el.scrollLeft = Math.min(
        maxScrollLeft,
        Math.max(
          0,
          drag.startScrollLeft +
            (event.clientX - drag.startX) * scrollPerPixel(),
        ),
      );
    };
    const handleThumbPointerMove = (event: PointerEvent): void => {
      dragTo(event);
    };
    const endThumbDrag = (event: PointerEvent): void => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setIsDragging(false);
      el.style.scrollBehavior = '';
      el.ownerDocument.documentElement.style.userSelect = '';
      if (thumb?.hasPointerCapture?.(event.pointerId)) {
        thumb.releasePointerCapture(event.pointerId);
      }
      if (track?.hasPointerCapture?.(event.pointerId)) {
        track.releasePointerCapture(event.pointerId);
      }
      scheduleHide();
    };

    // The thin-line track: hover reveals and holds the bar; a press on the
    // thumb drags from the grab point, a press beside it jumps there first.
    const track = trackRef.current;
    let trackHoverTimer: number | null = null;
    const clearTrackHoverTimer = (): void => {
      if (trackHoverTimer !== null) {
        window.clearTimeout(trackHoverTimer);
        trackHoverTimer = null;
      }
    };
    const handleTrackEnter = (): void => {
      if (el.scrollWidth - el.clientWidth <= EDGE_TOLERANCE_PX) return;
      clearTrackHoverTimer();
      // Only a pointer that rests on the line shows it.
      trackHoverTimer = window.setTimeout(() => {
        trackHoverTimer = null;
        thumbHoverRef.current = true;
        setIsTrackHovered(true);
        reveal();
      }, SCROLL_TRACK_HOVER_DELAY_MS);
    };
    const handleTrackLeave = (): void => {
      clearTrackHoverTimer();
      thumbHoverRef.current = false;
      setIsTrackHovered(false);
      if (revealedRef.current) scheduleHide();
    };
    const handleTrackPointerDown = (event: PointerEvent): void => {
      if (!track || !thumb || event.button !== 0) return;
      if (el.scrollWidth - el.clientWidth <= EDGE_TOLERANCE_PX) return;
      // No text selection while dragging.
      event.preventDefault();
      const rect = thumb.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right) {
        // Centre the thumb on the press, then drag on from there.
        el.style.scrollBehavior = 'auto';
        el.scrollLeft = Math.min(
          el.scrollWidth - el.clientWidth,
          Math.max(
            0,
            el.scrollLeft +
              (event.clientX - (rect.left + rect.right) / 2) * scrollPerPixel(),
          ),
        );
      }
      track.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: el.scrollLeft,
      };
      el.ownerDocument.documentElement.style.userSelect = 'none';
      setIsDragging(true);
      reveal();
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    el.addEventListener('wheel', handleWheelReveal, { passive: true });
    el.addEventListener('scroll', update, { passive: true });
    hoverTarget.addEventListener('pointerenter', handleScrollAreaEnter);
    hoverTarget.addEventListener('pointerleave', handleScrollAreaLeave);
    thumb?.addEventListener('pointerenter', handleThumbEnter);
    thumb?.addEventListener('pointerleave', handleThumbLeave);
    thumb?.addEventListener('pointerdown', handleThumbPointerDown);
    thumb?.addEventListener('pointermove', handleThumbPointerMove);
    thumb?.addEventListener('pointerup', endThumbDrag);
    thumb?.addEventListener('pointercancel', endThumbDrag);
    thumb?.addEventListener('lostpointercapture', endThumbDrag);
    track?.addEventListener('pointerenter', handleTrackEnter);
    track?.addEventListener('pointerleave', handleTrackLeave);
    track?.addEventListener('pointerdown', handleTrackPointerDown);
    track?.addEventListener('pointermove', dragTo);
    track?.addEventListener('pointerup', endThumbDrag);
    track?.addEventListener('pointercancel', endThumbDrag);
    track?.addEventListener('lostpointercapture', endThumbDrag);

    const view = el.ownerDocument.defaultView;
    const resizeObserver =
      view && 'ResizeObserver' in view ? new view.ResizeObserver(update) : null;
    resizeObserver?.observe(el);
    // Content changes land in bursts (a tab switch, a streaming title), and
    // each measurement makes the browser lay the page out, so they share one
    // measurement on the next frame.
    let mutationFrame: number | null = null;
    const updateOnNextFrame = (): void => {
      if (!view || typeof view.requestAnimationFrame !== 'function') {
        update();
        return;
      }
      if (mutationFrame !== null) return;
      mutationFrame = view.requestAnimationFrame(() => {
        mutationFrame = null;
        update();
      });
    };
    const mutationObserver =
      view && 'MutationObserver' in view
        ? new view.MutationObserver(updateOnNextFrame)
        : null;
    mutationObserver?.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    update();

    detachRef.current = (): void => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('wheel', handleWheelReveal);
      el.removeEventListener('scroll', update);
      hoverTarget.removeEventListener('pointerenter', handleScrollAreaEnter);
      hoverTarget.removeEventListener('pointerleave', handleScrollAreaLeave);
      thumb?.removeEventListener('pointerenter', handleThumbEnter);
      thumb?.removeEventListener('pointerleave', handleThumbLeave);
      thumb?.removeEventListener('pointerdown', handleThumbPointerDown);
      thumb?.removeEventListener('pointermove', handleThumbPointerMove);
      thumb?.removeEventListener('pointerup', endThumbDrag);
      thumb?.removeEventListener('pointercancel', endThumbDrag);
      thumb?.removeEventListener('lostpointercapture', endThumbDrag);
      clearTrackHoverTimer();
      track?.removeEventListener('pointerenter', handleTrackEnter);
      track?.removeEventListener('pointerleave', handleTrackLeave);
      track?.removeEventListener('pointerdown', handleTrackPointerDown);
      track?.removeEventListener('pointermove', dragTo);
      track?.removeEventListener('pointerup', endThumbDrag);
      track?.removeEventListener('pointercancel', endThumbDrag);
      track?.removeEventListener('lostpointercapture', endThumbDrag);
      el.ownerDocument.documentElement.style.userSelect = '';
      clearHideTimer();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (mutationFrame !== null) view?.cancelAnimationFrame(mutationFrame);
    };
  };

  // Runs after every commit, but only performs work when the referenced node's
  // identity changes (mount/unmount/replace). Observers handle later content
  // and size measurements without forcing layout reads after every unrelated
  // React commit.
  useEffect(() => {
    const el = ref.current;
    if (el !== boundNodeRef.current) {
      detachRef.current?.();
      detachRef.current = null;
      boundNodeRef.current = el;
      overflowRef.current = null;
      if (el) {
        bindListeners(el);
      }
    }
  });

  // Tear listeners down when the consuming component unmounts.
  useEffect(() => {
    return (): void => {
      detachRef.current?.();
      detachRef.current = null;
      boundNodeRef.current = null;
      overflowRef.current = null;
    };
  }, []);

  return {
    ref,
    trackRef,
    isScrollbarActive: hasOverflow && (isTrackHovered || isDragging),
    overflowRef,
    showStartFade,
    showEndFade,
    thumbRef,
    hasOverflow,
    isScrollbarRevealed:
      scrollbarBehavior === 'always'
        ? hasOverflow
        : scrollbarBehavior === 'never'
          ? false
          : scrollbarBehavior === 'hover'
            ? hasOverflow && isScrollAreaHovered
            : isScrollbarRevealed,
  };
}
