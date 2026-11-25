import type {
  OverlayLayerFollow,
  OverlayLayerRect,
} from '@canopy/desktop-shared/types';
import type { InAppNotificationPlacement } from '@canopy/ui-shared';

const SHADOW_MARGIN = 12;
// The toast's deepest shadow layer (`0 24px 24px -12px`) reaches 36px below it.
const SHADOW_DROP = 36;

/**
 * The native view clips its child document to this rectangle. Keep the resting
 * toast shadow inside it, while reserving the placement's growth edge for the
 * stack's entrance, spread, and swipe animations.
 */
export function calculateOverlayLayerBounds(
  rect: Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>,
  placement: InAppNotificationPlacement,
  viewportWidth: number,
  viewportHeight: number,
  expanded: boolean,
  swiping: boolean,
): OverlayLayerRect {
  const width = Math.max(0, Math.ceil(viewportWidth));
  const height = Math.max(0, Math.ceil(viewportHeight));
  const growsRight = placement.endsWith('right');
  const growsDown = placement.startsWith('top');

  const left = growsRight
    ? clamp(Math.floor(rect.left - SHADOW_MARGIN), 0, width)
    : 0;
  const right = growsRight
    ? width
    : clamp(Math.ceil(rect.right + SHADOW_MARGIN), 0, width);

  let top = clamp(Math.floor(rect.top - SHADOW_MARGIN), 0, height);
  let bottom = clamp(Math.ceil(rect.bottom + SHADOW_DROP), 0, height);

  // Never move the origin mid-gesture: the card compares pointer positions
  // from pointerdown, so a shifted origin turns a click into a drag. A swipe
  // therefore extends only the bottom, and keeps the spread's top.
  // shortcut: an upward swipe-out of a top-placed toast clips at the layer's
  // top edge, and a press that spreads an unhovered bottom stack (touch) moves
  // the origin once; widen before the press if either matters.
  if (expanded && !growsDown) top = 0;
  if (swiping || (expanded && growsDown)) bottom = height;

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Which window edge each edge of the layer from
 * {@link calculateOverlayLayerBounds} keeps its distance to, so the main
 * process can move the layer with the window while it resizes. A corner
 * stack sits a fixed distance from its corner; an edge the bounds stretch to
 * (the spread's far edge, the swipe's room) is the window's own edge.
 */
export function overlayLayerEdges(
  placement: InAppNotificationPlacement,
  expanded: boolean,
  swiping: boolean,
): OverlayLayerFollow['edges'] {
  const growsRight = placement.endsWith('right');
  const growsDown = placement.startsWith('top');
  const side = growsRight ? 'end' : 'start';
  return {
    left: side,
    right: side,
    top: growsDown || expanded ? 'start' : 'end',
    bottom: growsDown && !(swiping || expanded) ? 'start' : 'end',
  };
}
