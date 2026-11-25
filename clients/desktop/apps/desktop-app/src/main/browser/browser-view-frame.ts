import { View } from 'electron';
import type { Rectangle, WebContentsView } from 'electron';
import type { BrowserCornerRadii } from '@canopy/desktop-shared/types';

/**
 * The Browser page's frame in its host window.
 *
 * The page fills its card's body edge to edge: flush under the toolbar with
 * square top corners, rounded only where it meets the card's own rounded
 * corners. A native view paints over the renderer, so no CSS clip reaches it,
 * and Electron rounds a view's four corners alike. So the page sits in a
 * rounded `clip` view that reaches past the page on each side whose corners
 * stay square, which pushes those rounded corners out of sight. The `frame`
 * around it is cut to the page area exactly, so the reach never covers (or
 * takes input from) the toolbar or the card around the page.
 */
export interface BrowserViewFrame {
  /** Window child, cut to the page area. Owns position and visibility. */
  readonly frame: View;
  /** Rounded clip around the page, reaching past its square corners. */
  readonly clip: View;
}

export interface BrowserViewFrameLayout {
  frame: Rectangle;
  clip: Rectangle;
  page: Rectangle;
  radius: number;
}

export const SQUARE_CORNERS: BrowserCornerRadii = {
  topLeft: 0,
  topRight: 0,
  bottomRight: 0,
  bottomLeft: 0,
};

function cornerRadius(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Lays the frame, clip and page out for a page area at `bounds` (window
 * DIPs) whose corners round by `radii` (window DIPs). Rounded corners share
 * the largest requested radius; a side reaches out when both of its corners
 * are square.
 *
 * The clip never rounds by less than 1: once it has a layer, a zero radius
 * gives it an empty mask, which would hide the whole page. A page with no
 * rounded corners (the Browser outside a card, such as MCP sign-in) keeps a
 * 1 radius with every side reaching 1 past the page, so no rounding shows.
 */
export function layoutBrowserViewFrame(
  bounds: Rectangle,
  radii: BrowserCornerRadii,
): BrowserViewFrameLayout {
  const topLeft = cornerRadius(radii.topLeft);
  const topRight = cornerRadius(radii.topRight);
  const bottomRight = cornerRadius(radii.bottomRight);
  const bottomLeft = cornerRadius(radii.bottomLeft);
  const radius = Math.max(
    1,
    Math.round(Math.max(topLeft, topRight, bottomRight, bottomLeft)),
  );
  const reach = (first: number, second: number): number =>
    first === 0 && second === 0 ? radius : 0;
  const top = reach(topLeft, topRight);
  const right = reach(topRight, bottomRight);
  const bottom = reach(bottomRight, bottomLeft);
  const left = reach(bottomLeft, topLeft);
  return {
    frame: { ...bounds },
    clip: {
      x: -left || 0,
      y: -top || 0,
      width: bounds.width + left + right,
      height: bounds.height + top + bottom,
    },
    page: { x: left, y: top, width: bounds.width, height: bounds.height },
    radius,
  };
}

export function createBrowserViewFrame(
  page: WebContentsView,
): BrowserViewFrame {
  const frame = new View();
  const clip = new View();
  // A view's rounding clips views inside it only once it paints to its own
  // layer, which Electron creates for a bounds animation. A zero-length one
  // gives the clip its layer without moving it.
  clip.setBounds(
    { x: 0, y: 0, width: 0, height: 0 },
    {
      animate: { duration: 0 },
    },
  );
  clip.addChildView(page);
  frame.addChildView(clip);
  return { frame, clip };
}

/** The layout each frame was last given. */
const appliedLayouts = new WeakMap<BrowserViewFrame, string>();

/**
 * Applies `layout`, unless the frame already has it. The pane reports its
 * area on every window resize event and again from its resize observer, so
 * the same layout arrives several times per frame of a window resize, and
 * each native move makes the page lay itself out and draw again.
 */
export function applyBrowserViewFrameLayout(
  views: BrowserViewFrame,
  page: WebContentsView,
  layout: BrowserViewFrameLayout,
): void {
  const key = JSON.stringify(layout);
  if (appliedLayouts.get(views) === key) return;
  appliedLayouts.set(views, key);
  views.frame.setBounds(layout.frame);
  views.clip.setBounds(layout.clip);
  page.setBounds(layout.page);
  // After the bounds: Electron fits the radius to the clip's current size.
  views.clip.setBorderRadius(layout.radius);
}
