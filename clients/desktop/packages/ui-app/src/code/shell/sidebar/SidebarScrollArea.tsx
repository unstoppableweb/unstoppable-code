import {
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
import { useScrollbarBehavior } from '@canopy/ui-shared/lib';

interface SidebarScrollAreaProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'onScroll'
> {
  readonly children: ReactNode;
  readonly contentClassName?: string;
  readonly viewportClassName?: string;
  readonly viewportTestId?: string;
  readonly onViewportScroll?: HTMLAttributes<HTMLDivElement>['onScroll'];
  readonly onViewportWheel?: (event: WheelEvent) => void;
  readonly onViewportLayout?: (viewport: HTMLDivElement) => void;
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
 * thumb drag before fading out. Matches the Radix ScrollArea default; VS Code
 * uses 500ms for the same idle fade.
 */
export const SIDEBAR_SCROLLBAR_HIDE_DELAY_MS = 600;

/**
 * Sidebar scroll viewport with an absolutely positioned scrollbar.
 * The native scrollbar is hidden so it never participates in layout. The
 * custom scrollbar follows the macOS overlay convention: hidden while idle,
 * revealed only by direct user scrolling (wheel/trackpad input), and pinned
 * visible while the pointer is over the revealed rail or a thumb drag is in
 * progress, then fades out after the idle hide delay. Programmatic scrolls
 * (startup restoration, scrollIntoView), content growth that merely creates
 * overflow (e.g. expanding a workspace), and cursor proximity to the hidden
 * rail all stay silent.
 */
export function SidebarScrollArea({
  children,
  className = '',
  contentClassName = '',
  viewportClassName = '',
  viewportTestId,
  onViewportScroll,
  onViewportWheel,
  onViewportLayout,
  ...wrapperProps
}: SidebarScrollAreaProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const railHoverRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const isRevealedRef = useRef(false);
  const onViewportWheelRef = useRef(onViewportWheel);
  const onViewportLayoutRef = useRef(onViewportLayout);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const scrollbarBehavior = useScrollbarBehavior(viewportRef);
  const isVisible =
    hasOverflow &&
    (scrollbarBehavior === 'always' ||
      (scrollbarBehavior === 'scroll' && isRevealed) ||
      (scrollbarBehavior === 'hover' && isHovered));

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  // While the pointer is over the rail or a thumb drag is in progress the
  // scrollbar is pinned: no hide is scheduled, and the pointerleave/drag-end
  // handlers reschedule it.
  const scheduleHide = useCallback((): void => {
    clearHideTimer();
    if (railHoverRef.current || dragRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      isRevealedRef.current = false;
      setIsRevealed(false);
    }, SIDEBAR_SCROLLBAR_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const reveal = useCallback((): void => {
    isRevealedRef.current = true;
    setIsRevealed(true);
    scheduleHide();
  }, [scheduleHide]);

  const updateRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    onViewportWheelRef.current = onViewportWheel;
    onViewportLayoutRef.current = onViewportLayout;
    updateRef.current = (): void => {
      const viewport = viewportRef.current;
      const thumb = thumbRef.current;
      if (!viewport || !thumb) return;

      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      const overflow = maxScrollTop > EDGE_TOLERANCE_PX;
      setHasOverflow(overflow);
      if (!overflow) {
        // Fully retire the reveal, not just mask it: a lingering reveal (and
        // its pending hide timer) would resurrect the scrollbar without new
        // wheel input if overflow returned within the hide delay.
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
      const trackHeight = paintedHeight - THUMB_END_INSET_PX * 2;
      const thumbHeight = Math.max(
        MIN_THUMB_HEIGHT_PX,
        (paintedHeight / viewport.scrollHeight) * trackHeight,
      );
      const maxThumbTop = trackHeight - thumbHeight;
      // Clamp: `maxScrollTop` derives from the rounded `clientHeight`, so a
      // fractional viewport lets `scrollTop` run slightly past it at the
      // extreme, which would otherwise push the thumb past its inset.
      const scrollProgress =
        maxScrollTop > 0
          ? Math.min(1, Math.max(0, viewport.scrollTop / maxScrollTop))
          : 0;
      const thumbTop = THUMB_END_INSET_PX + scrollProgress * maxThumbTop;

      const height = `${thumbHeight}px`;
      const transform = `translateY(${thumbTop}px)`;
      if (thumb.style.height !== height) thumb.style.height = height;
      if (thumb.style.transform !== transform) {
        thumb.style.transform = transform;
      }
    };
  }, [clearHideTimer, onViewportLayout, onViewportWheel]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport) return undefined;

    const view = viewport.ownerDocument.defaultView;
    let layoutFrameId: number | null = null;
    let hostLayoutPending = false;
    let hostLayoutWasDeferred = false;
    const scheduleFrame = (): void => {
      if (!view || typeof view.requestAnimationFrame !== 'function') {
        updateLayout();
        return;
      }
      if (layoutFrameId !== null) return;
      layoutFrameId = view.requestAnimationFrame(() => {
        layoutFrameId = null;
        updateLayout();
      });
    };
    const updateLayout = (): void => {
      const shouldUpdateHostLayout = hostLayoutPending;
      hostLayoutPending = false;
      // Keep the observer pass read-first: update the scrollbar's measurements
      // before the host writes sticky clip/translation styles.
      updateRef.current();
      if (shouldUpdateHostLayout) {
        // Scrollbar geometry can write thumb styles. Give Chromium one frame
        // to commit those writes before the host reads thousands of sidebar
        // descendants for sticky geometry; combining both phases forces a
        // second full style/layout pass in this callback. Bound the deferral
        // to one frame so continuous ResizeObserver updates cannot starve the
        // host layout.
        if (
          !hostLayoutWasDeferred &&
          view &&
          typeof view.requestAnimationFrame === 'function'
        ) {
          hostLayoutWasDeferred = true;
          hostLayoutPending = true;
          scheduleFrame();
          return;
        }
        hostLayoutWasDeferred = false;
        onViewportLayoutRef.current?.(viewport);
      }
    };
    const scheduleLayout = (includeHostLayout: boolean): void => {
      hostLayoutPending ||= includeHostLayout;
      scheduleFrame();
    };
    const resizeObserver =
      view && 'ResizeObserver' in view
        ? new view.ResizeObserver(() => scheduleLayout(true))
        : null;
    // Structural changes to the sticky rail — a seat for a pinned header
    // copy or a sticky header itself arriving or leaving — re-run the host's
    // layout sync too: its layout cache indexes those nodes, and the shared
    // surface seats its rows a commit after the workspace rows mount.
    const STICKY_RAIL_NODE_SELECTOR =
      '[data-sidebar-sticky-slot-workspace-id], .sidebar-workspace-sticky-header, [data-sidebar-item-group-id], [data-sidebar-item-group-header]';
    const touchesStickyRail = (nodes: NodeList): boolean =>
      Array.from(nodes).some(
        (node) =>
          node instanceof Element &&
          (node.matches(STICKY_RAIL_NODE_SELECTOR) ||
            node.querySelector(STICKY_RAIL_NODE_SELECTOR) !== null),
      );
    const mutationObserver =
      view && 'MutationObserver' in view
        ? new view.MutationObserver((records) =>
            scheduleLayout(
              records.some(
                (record) =>
                  (record.type === 'attributes' &&
                    [
                      'data-sidebar-selected-item',
                      'data-sidebar-item-group-id',
                    ].includes(record.attributeName ?? '')) ||
                  (record.type === 'childList' &&
                    ((record.target instanceof Element &&
                      record.target.closest('[data-sidebar-item-group-id]') !==
                        null) ||
                      touchesStickyRail(record.addedNodes) ||
                      touchesStickyRail(record.removedNodes))),
              ),
            ),
          )
        : null;

    resizeObserver?.observe(viewport);
    if (content) {
      resizeObserver?.observe(content);
    }
    mutationObserver?.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
      // Selection changes re-anchor the pinned selected-item copies but may
      // otherwise only mutate attributes (highlight classes and the
      // `data-sidebar-selected-item` mark). Observe exactly that mark so a
      // selection change re-runs the host's layout sync without subscribing
      // to the sidebar's high-frequency class churn.
      attributes: true,
      attributeFilter: [
        'data-sidebar-selected-item',
        'data-sidebar-item-group-id',
      ],
    });
    const handleWheel = (event: WheelEvent): void => {
      onViewportWheelRef.current?.(event);
      // Only direct user input reveals the scrollbar. Programmatic scrolls
      // (startup restoration, scrollIntoView, collapse adjustments) fire
      // scroll events but never wheel events, so they stay silent.
      if (viewport.scrollHeight - viewport.clientHeight > EDGE_TOLERANCE_PX) {
        reveal();
      }
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    // The rail listens natively (it sits outside the viewport element) so the
    // pointer can pin a revealed scrollbar while hovering it. It never
    // reveals a hidden one: the rail is pointer-inert while faded out, and
    // the guard below keeps the semantics explicit for synthetic events.
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
    // Establish scrollbar geometry immediately, but keep host layout work out
    // of the effect's initial renderer task. The scheduled callback also
    // absorbs any ResizeObserver/MutationObserver notifications caused by the
    // surrounding startup commit.
    updateRef.current();
    scheduleLayout(true);

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
  }, [clearHideTimer, reveal, scheduleHide]);

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
    const availableTrack = viewport.clientHeight - thumbHeight;
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

  return (
    <div
      {...wrapperProps}
      className={`relative ${className}`}
      data-sidebar-scroll-area=""
      onPointerEnter={(event) => {
        setIsHovered(true);
        wrapperProps.onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        setIsHovered(false);
        wrapperProps.onPointerLeave?.(event);
      }}
    >
      <div
        ref={viewportRef}
        className={`scrollbar-hide h-full overflow-y-auto ${viewportClassName}`}
        data-testid={viewportTestId}
        onScroll={(event) => {
          updateRef.current();
          onViewportScroll?.(event);
        }}
      >
        <div
          ref={contentRef}
          className={contentClassName}
          data-sidebar-scroll-content=""
        >
          {children}
        </div>
      </div>
      {/* `z-50` puts the rail above every sticky layer the viewport holds:
          the pinned More row and Chats header (`z-40`), workspace sticky
          headers (`z-30`) and the bottom pin band (`z-20`). Neither the
          viewport nor this wrapper is a stacking context, so an opaque
          header stacked higher would paint over the thumb wherever the thumb
          reaches past the content's 8px gutter — which it does with classic
          ("Always") scrollbar geometry (CAN-3451). */}
      <div
        ref={railRef}
        aria-hidden="true"
        className={`absolute inset-y-0 right-0 z-50 ${
          isVisible
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        }`}
        data-sidebar-scrollbar=""
      >
        <div
          ref={thumbRef}
          className={`absolute top-0 touch-none rounded-full bg-fg-quaternary/50 ${
            isVisible ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
          data-sidebar-scrollbar-thumb=""
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
