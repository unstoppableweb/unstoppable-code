'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import {
  FloatingMenu,
  FloatingMenuPointAnchor,
  type FloatingMenuPlacement,
  type FloatingMenuPoint,
} from './FloatingMenu';

interface PopoverBaseProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Names the panel for assistive tech; or pass `aria-labelledby`. */
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'data-testid'?: string;
  readonly id?: string;
  readonly placement?: FloatingMenuPlacement;
  readonly gap?: number;
  /**
   * The panel's width: `sm` 224px, `md` 288px (default), `lg` 320px, or
   * `content` to fit what it holds. Surface, inset, radius, shadow and layer
   * belong to the popover.
   */
  readonly width?: PopoverWidth;
  /** First focus target; defaults to the first focusable descendant. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** Where focus returns on close; defaults to the anchor. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  /** Presses inside this element do not close the popover. */
  readonly outsidePressBoundaryRef?: RefObject<HTMLElement | null>;
  /**
   * `false` while it may not close (an action it started is running): an
   * outside press is ignored and its click still lands.
   */
  readonly closeOnOutsidePress?: boolean;
  /**
   * `false` when a press outside should both close the popover and land, as
   * on the next diff line of a review: the user picks another line in one
   * press rather than two.
   */
  readonly outsidePressSwallowsClick?: boolean;
  /**
   * `section` (default) insets the content 12px. `flush` leaves the content
   * to lay itself out to the surface's edges, for a body with its own
   * sections, rules or sticky header.
   */
  readonly inset?: 'section' | 'flush';
  /**
   * Keep presses and clicks inside the popover from bubbling (through the
   * React tree) to the anchor's ancestors. The popover is portaled out of
   * their DOM, but React still bubbles to them, so a press in a diff
   * comment would otherwise start a line selection underneath.
   */
  readonly containEvents?: boolean;
  /**
   * `none` for a popover opened from a frequently used control (a composer
   * control), where entry motion would only delay it.
   */
  readonly motion?: 'enter' | 'none';
  readonly children: ReactNode;
}

interface PopoverAtControlProps extends PopoverBaseProps {
  /** The control the popover hangs off. */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly anchorPoint?: never;
  readonly anchorRect?: never;
  readonly ownerDocument?: Document;
}

interface PopoverAtPointProps extends PopoverBaseProps {
  readonly anchorRef?: never;
  readonly anchorRect?: never;
  /** A point in `ownerDocument`'s viewport, such as a selection's end. */
  readonly anchorPoint: FloatingMenuPoint;
  readonly ownerDocument: Document;
}

interface PopoverAtRectProps extends PopoverBaseProps {
  readonly anchorRef?: never;
  readonly anchorPoint?: never;
  /**
   * A box in `ownerDocument`'s viewport, such as a text selection or a diff
   * line: the popover hangs off it and, flipping, clears it.
   */
  readonly anchorRect: PopoverAnchorRect;
  readonly ownerDocument: Document;
}

export interface PopoverAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type PopoverProps =
  | PopoverAtControlProps
  | PopoverAtPointProps
  | PopoverAtRectProps;

function stopAtSurface(event: SyntheticEvent): void {
  event.stopPropagation();
}

export type PopoverWidth = 'sm' | 'md' | 'lg' | 'content';

/**
 * A small panel tied to a control, a point or a box: a preview, a short form.
 * Built on `FloatingMenu`, so it places, flips and clamps in the window like
 * every menu, on the menu surface (fill, radius, shadow) with a 12px inset.
 * Opening moves focus into it and keeps Tab inside; Escape, an outside
 * press, and for a point a window resize or blur close it, and focus goes
 * back to the control. A `dialog` role names it; it is not modal.
 */
export function Popover(props: PopoverProps): JSX.Element {
  const {
    open,
    onOpenChange,
    placement = 'bottom-left',
    gap,
    width = 'md',
    initialFocusRef,
    returnFocusRef,
    outsidePressBoundaryRef,
    closeOnOutsidePress = true,
    outsidePressSwallowsClick = true,
    inset = 'section',
    containEvents = false,
    motion = 'enter',
    children,
    id,
  } = props;
  const pointAnchorRef = useRef<HTMLSpanElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const anchorRef = props.anchorRef ?? pointAnchorRef;
  // Only a point popover closes on a window resize or blur, as a context
  // menu does. A box popover holds a draft (a review or plan comment), which
  // switching windows must not throw away.
  const atPoint = props.anchorPoint !== undefined;
  const focusWasInside = useRef(false);
  // A point or box anchor is not focusable, so a popover opened from one
  // sends focus back to whatever had it when it opened (the diff editor,
  // the plan text), recorded before the popover moves focus in.
  const openerRef = useRef<HTMLElement | null>(null);
  const atAnchorElement = props.anchorRef !== undefined;
  useLayoutEffect((): void => {
    if (!open || atAnchorElement) return;
    const doc =
      props.ownerDocument ??
      (typeof document === 'undefined' ? undefined : document);
    const active = doc?.activeElement;
    const View = doc?.defaultView?.HTMLElement;
    openerRef.current =
      View !== undefined && active instanceof View && active !== doc?.body
        ? active
        : null;
  }, [open, atAnchorElement, props.ownerDocument]);

  // When the popover closes itself (a Done or Cancel inside it), its focused
  // control unmounts and focus would fall to <body>; send it back instead.
  useEffect((): (() => void) | void => {
    if (!open) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const doc = surface.ownerDocument;
    const track = (): void => {
      focusWasInside.current = surface.contains(doc.activeElement);
    };
    doc.addEventListener('focusin', track);
    track();
    return (): void => {
      doc.removeEventListener('focusin', track);
      const active = doc.activeElement;
      const lost =
        active === null || active === doc.body || surface.contains(active);
      if (focusWasInside.current && lost) {
        const opener = openerRef.current;
        (
          returnFocusRef?.current ??
          props.anchorRef?.current ??
          (opener?.isConnected ? opener : null)
        )?.focus({
          preventScroll: true,
        });
      }
      focusWasInside.current = false;
    };
  }, [open, props.anchorRef, returnFocusRef]);

  return (
    <>
      {props.anchorPoint !== undefined && open ? (
        <FloatingMenuPointAnchor
          ref={pointAnchorRef}
          x={props.anchorPoint.x}
          y={props.anchorPoint.y}
          ownerDocument={props.ownerDocument}
        />
      ) : null}
      {props.anchorRect !== undefined && open ? (
        <FloatingMenuPointAnchor
          ref={pointAnchorRef}
          x={props.anchorRect.left}
          y={props.anchorRect.top}
          width={props.anchorRect.width}
          height={props.anchorRect.height}
          ownerDocument={props.ownerDocument}
        />
      ) : null}
      <FloatingMenu
        ref={surfaceRef}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        {...(props.anchorPoint !== undefined
          ? { anchorPoint: props.anchorPoint }
          : {})}
        {...(props.ownerDocument !== undefined
          ? { ownerDocument: props.ownerDocument }
          : {})}
        {...(returnFocusRef ? { returnFocusRef } : {})}
        {...(initialFocusRef ? { initialFocusRef } : {})}
        {...(outsidePressBoundaryRef ? { outsidePressBoundaryRef } : {})}
        {...(gap === undefined ? {} : { gap })}
        closeOnWindowChange={atPoint}
        closeOnOutsidePress={closeOnOutsidePress}
        outsidePressSwallowsClick={outsidePressSwallowsClick}
        placement={placement}
        interaction="manual"
        trapFocus
        openOnArrowKeys={false}
        motion={motion}
        role="dialog"
        padding={inset === 'flush' ? 'none' : 'readout'}
        id={id}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        data-testid={props['data-testid']}
        {...(containEvents
          ? {
              onPointerDown: stopAtSurface,
              onMouseDown: stopAtSurface,
              onMouseUp: stopAtSurface,
              onClick: stopAtSurface,
            }
          : {})}
        // `manual` turns off FloatingMenu's scroll viewport, so the surface
        // scrolls itself within the max height FloatingMenu measures for the
        // window: a tall popover in a short window keeps every control
        // reachable.
        className={
          width === 'sm'
            ? 'w-56 overflow-y-auto overscroll-contain'
            : width === 'lg'
              ? 'w-80 overflow-y-auto overscroll-contain'
              : width === 'content'
                ? 'w-max overflow-y-auto overscroll-contain'
                : 'w-72 overflow-y-auto overscroll-contain'
        }
      >
        {children}
      </FloatingMenu>
    </>
  );
}
