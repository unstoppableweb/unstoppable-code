import { useEffect } from 'react';
import { pushMenuOpenBodyFlag } from '@canopy/ui-shared/lib';

/**
 * While any sidebar dropdown/context menu is open, background sidebar rows
 * must not paint hover feedback — the pointer is interacting with the menu,
 * not the rows under it. Delegates to the shared reference-counted body flag
 * (`data-sidebar-menu-open`, also set by Menu
 * directly); globals.css scopes the hover suppression off that attribute.
 * Only bespoke menu portals (e.g. the worktree ••• menu) need this hook —
 * menus built on the shared primitives set the flag themselves.
 */
export function useSuspendSidebarHovers(open: boolean): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    return pushMenuOpenBodyFlag(document);
  }, [open]);
}
