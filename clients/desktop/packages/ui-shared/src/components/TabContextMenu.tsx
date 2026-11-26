'use client';

import { useRef, useState, type JSX } from 'react';
import {
  FloatingMenu,
  FloatingMenuPointAnchor,
} from '../primitives/FloatingMenu';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from '../primitives/ActionMenuItems';

/**
 * A right-click menu row. Tab, message and other point-anchored menus use the
 * same rows as every action menu: an icon on each row, groups split by
 * `separatorBefore`, and close or removal rows in the last group.
 */
export type TabContextMenuItem = ActionMenuItem;

export interface TabContextMenuProps {
  x: number;
  y: number;
  items: readonly TabContextMenuItem[];
  onClose: () => void;
  /**
   * The document that owns the element the menu was opened from. Defaults to
   * the renderer's global `document`. Pass the child document for a menu
   * opened inside a pulled-out auxiliary window so the menu opens in (and
   * positions against) that window instead of the main one.
   */
  ownerDocument?: Document;
  /** Optional root `data-testid` for the menu container. */
  dataTestId?: string;
  /**
   * Move focus to the first enabled item when the menu opens, so a menu
   * opened from the keyboard can be driven with the arrow keys right away.
   * Off by default: pointer-opened tab menus leave focus where it was.
   */
  focusOnOpen?: boolean;
}

const VIEWPORT_PADDING = 4;

function isChoosable(item: TabContextMenuItem): boolean {
  return !item.disabled && item.onSelect !== undefined;
}

/**
 * A right-click menu at the pointer: the shared `FloatingMenu` anchored at a
 * `FloatingMenuPointAnchor`, so it places, flips, dismisses (Escape, an
 * outside press) and moves focus like every other menu.
 */
export function TabContextMenu({
  x,
  y,
  items,
  onClose,
  ownerDocument,
  dataTestId,
  focusOnOpen = false,
}: TabContextMenuProps): JSX.Element | null {
  const doc = ownerDocument ?? document;
  const anchorRef = useRef<HTMLSpanElement>(null);
  // Escape returns focus to whatever held it when the menu opened (the tab
  // or message), since the point anchor itself cannot take focus.
  const [opener] = useState(() => {
    const active = doc.activeElement;
    const view = doc.defaultView;
    return view !== null && active instanceof view.HTMLElement ? active : null;
  });
  const returnFocusRef = useRef<HTMLElement | null>(opener);

  if (!doc.body) return null;

  const selectItem = (item: TabContextMenuItem): void => {
    if (item.disabled || !item.onSelect) return;
    item.onSelect();
    if (item.role !== 'menuitemradio') onClose();
  };

  return (
    <>
      <FloatingMenuPointAnchor
        ref={anchorRef}
        x={x}
        y={y}
        ownerDocument={doc}
      />
      <FloatingMenu
        open
        onOpenChange={(open): void => {
          if (!open) onClose();
        }}
        anchorRef={anchorRef}
        anchorPoint={{ x, y }}
        ownerDocument={doc}
        returnFocusRef={returnFocusRef}
        closeOnWindowChange
        placement="bottom-left"
        gap={0}
        viewportPadding={VIEWPORT_PADDING}
        // A frequent right-click menu appears at once, like the sidebar's.
        motion="none"
        // With nothing to choose, focus stays where it was.
        focusOnOpen={focusOnOpen && items.some(isChoosable)}
        // Rows close the menu themselves; a radio row keeps it open.
        closeOnSelect={false}
        data-testid={dataTestId}
        className="min-w-45"
        onContextMenu={(event): void => event.preventDefault()}
      >
        <ActionMenuRowStyle>
          <ActionMenuItems items={items} onSelect={selectItem} />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
}
