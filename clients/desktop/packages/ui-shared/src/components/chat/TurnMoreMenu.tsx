import { useId, useRef, type JSX, type ReactNode } from 'react';
import { MoreHorizontalIcon } from '../../icons/AppIcons';
import { Button } from '../../primitives/Button';
import { CLEAN_ICON_BUTTON_VARIANT } from '../chat-look';
import {
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
} from '../../primitives/DropdownMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from '../../primitives/FloatingMenu';
import { TurnFeedbackAsMenuItemsContext } from '../TurnFeedbackControl';
import { Tooltip } from '../../primitives/Tooltip';

/**
 * The clean chat look's "…" at the end of a reply's action row, after the
 * ChatGPT transcript: the less-used actions (branch into a worktree, share,
 * run comments) live in this small menu instead of more icons. Hosts own
 * the open state so a menu item can close it after opening a dialog, and
 * pass `DropdownMenuItem`s as children.
 */
export function TurnMoreMenu({
  open,
  onOpenChange,
  children,
  label = 'More actions',
  dataTestId = 'turn-more-actions',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The menu's items. */
  children: ReactNode;
  /** The trigger's name and tooltip, in sentence case. */
  label?: string;
  dataTestId?: string;
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  return (
    <>
      <Tooltip label={label} suppressed={open}>
        <Button
          ref={triggerRef}
          variant={CLEAN_ICON_BUTTON_VARIANT}
          size="sm"
          iconOnly
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-testid={dataTestId}
          data-open={open ? '' : undefined}
          onClick={(event): void => {
            event.stopPropagation();
            onOpenChange(!open);
          }}
        >
          <MoreHorizontalIcon size="sm" aria-hidden="true" />
        </Button>
      </Tooltip>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={triggerRef}
        placement="bottom-left"
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-label={label}
        data-testid={`${dataTestId}-menu`}
        className="w-max min-w-48"
        onClick={(event): void => {
          event.stopPropagation();
          // Picking any row closes the menu; dialogs a row opens live
          // outside it.
          if (
            event.target instanceof Element &&
            event.target.closest('[role^="menuitem"]') !== null
          )
            onOpenChange(false);
        }}
      >
        {/* Small text and quiet icons, like the reference's menu. The thumbs
            render as "Good response" / "Bad response" rows here. */}
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          <TurnFeedbackAsMenuItemsContext.Provider value>
            {children}
          </TurnFeedbackAsMenuItemsContext.Provider>
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}
