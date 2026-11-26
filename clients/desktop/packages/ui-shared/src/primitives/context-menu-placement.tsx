import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * Where a right-click menu opens. `anchored` keeps each menu's own
 * placement. `cursor` follows the desktop convention (macOS and Windows):
 * the menu's top-left corner sits at the pointer, and it flips to the other
 * side of the pointer on an axis where it would not fit, so it never covers
 * the pointer. Hosts choose it once at their root; desktop picks `cursor`
 * under early access.
 */
export type ContextMenuPlacement = 'anchored' | 'cursor';

const ContextMenuPlacementContext =
  createContext<ContextMenuPlacement>('anchored');

export function ContextMenuPlacementProvider({
  value,
  children,
}: {
  readonly value: ContextMenuPlacement;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ContextMenuPlacementContext.Provider value={value}>
      {children}
    </ContextMenuPlacementContext.Provider>
  );
}

export function useContextMenuPlacement(): ContextMenuPlacement {
  return useContext(ContextMenuPlacementContext);
}

/** Space between the pointer tip and the menu's corner. */
export const CONTEXT_MENU_POINTER_OFFSET = 2;
/** Minimum inset from the viewport edges. */
export const CONTEXT_MENU_VIEWPORT_PADDING = 8;

export interface ContextMenuAtPointInput {
  /** The pointer, in viewport coordinates. */
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  offset?: number;
  viewportPadding?: number;
}

/**
 * The menu's top-left for a right-click at a point. It opens below and to
 * the right of the pointer; on an axis where it would cross the viewport
 * edge it opens on the other side of the pointer instead, and only when
 * neither side fits does it shift to stay on screen.
 */
export function placeContextMenuAtPoint({
  x,
  y,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  offset = CONTEXT_MENU_POINTER_OFFSET,
  viewportPadding = CONTEXT_MENU_VIEWPORT_PADDING,
}: ContextMenuAtPointInput): { left: number; top: number } {
  const axis = (point: number, size: number, viewport: number): number => {
    const after = point + offset;
    if (after + size <= viewport - viewportPadding) return after;
    const before = point - offset - size;
    if (before >= viewportPadding) return before;
    return Math.max(
      viewportPadding,
      Math.min(after, viewport - size - viewportPadding),
    );
  };
  return {
    left: axis(x, menuWidth, viewportWidth),
    top: axis(y, menuHeight, viewportHeight),
  };
}
