import type { JSX } from 'react';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
} from '../primitives/DropdownMenu';
import { PinIcon } from '../icons/AppIcons';

export interface SidebarPinMenuItemProps {
  pinned: boolean;
  onToggle: (pinned: boolean) => void;
  testId: string;
}

/**
 * The Pin/Unpin entry shared by sidebar row and section menus (CAN-1074).
 * Pins are section scoped: a pinned row floats to the top of its own section
 * and never leaves it.
 *
 * Every sidebar item menu renders this first and reads the same, whether the
 * row is a project, a worktree, or a Work Entry: one wording and one position
 * means the control does not move as the user walks down the sidebar. The
 * subject is the row the menu belongs to, so naming it again in the label
 * ("Pin project") only made the entries differ for no gain.
 *
 * Shared so the desktop rail and the web portal's Chats section offer the
 * same entry (CAN-3053).
 */
export function SidebarPinMenuItem({
  pinned,
  onToggle,
  testId,
}: SidebarPinMenuItemProps): JSX.Element {
  return (
    <DropdownMenuItem
      data-testid={testId}
      onClick={(event): void => {
        event.stopPropagation();
        onToggle(!pinned);
      }}
    >
      <DropdownMenuItemIcon>
        <PinIcon />
      </DropdownMenuItemIcon>
      <span className="truncate">{pinned ? 'Unpin' : 'Pin to top'}</span>
    </DropdownMenuItem>
  );
}
