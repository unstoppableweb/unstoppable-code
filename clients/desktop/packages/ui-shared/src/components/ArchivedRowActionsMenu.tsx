'use client';

import { useId, useRef, useState, type JSX } from 'react';
import {
  ArchiveIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  TrashIcon,
  TrashPermanentlyIcon,
} from '../icons/AppIcons';
import { menuDismissalSwallowsClick } from '../lib/menu-open-body-flag';
import { ActionMenuRowStyle } from './ActionMenuItems';
import { ARCHIVED_ROW_ACTIONS_VISIBLE_WIDE } from './ArchivedOverviewRow';
import { Button } from './Button';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
} from './DropdownMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from './FloatingMenu';

export interface ArchivedRowActionsMenuProps {
  /** Item title, used for the trigger's and menu's accessible names. */
  itemName: string;
  /** Archived items offer Delete; Deleted items offer Archive. */
  archived: boolean;
  /** A lifecycle request is in flight: every action is disabled. */
  busy?: boolean;
  /**
   * When set, Restore is disabled and this sentence renders beneath it
   * inside the menu (and describes the item for assistive technology), so
   * keyboard and touch users can see why the action is unavailable.
   */
  restoreBlockedReason?: string;
  onRestore: () => void;
  onToggleState: () => void;
  /** Hosts confirm before purging; the menu only announces the intent. */
  onDeletePermanently: () => void;
  /**
   * Prefixes every data-testid: `-actions` (trigger), `-menu`, `-restore`,
   * `-restore-reason`, `-state`, and `-delete` (Permanent).
   */
  testIdPrefix: string;
  /** Extra trigger classes; defaults to the wide-container always-visible set. */
  triggerClassName?: string;
}

/**
 * The ⋯ action menu for one retained item in an "Archived and deleted"
 * overview, shared by desktop and web. A Deleted item offers Restore and
 * Archive; an Archived item offers Restore and Delete (back to the
 * retention countdown). Restore leads; the removal rows (Archive or Delete,
 * then Permanent) close the menu in their own group. Archive and Delete are
 * recoverable and read neutral; Permanent (delete for good) takes the
 * destructive tone.
 *
 * The trigger is hover/focus-revealed by default, always visible (with a
 * 44px target) on touch, and pinned visible on wide containers through the
 * container-query classes the row shell shares.
 */
export function ArchivedRowActionsMenu({
  itemName,
  archived,
  busy = false,
  restoreBlockedReason,
  onRestore,
  onToggleState,
  onDeletePermanently,
  testIdPrefix,
  triggerClassName = ARCHIVED_ROW_ACTIONS_VISIBLE_WIDE,
}: ArchivedRowActionsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const reasonId = useId();
  const restoreBlocked = restoreBlockedReason !== undefined;
  return (
    <>
      {/* The wrapper owns the reveal; the Button keeps the per-row action
          look and its 44px coarse-pointer hit area. */}
      <span
        className={`inline-flex pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 ${triggerClassName} ${
          open ? 'pointer-events-auto opacity-100' : ''
        }`}
      >
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`More actions for ${itemName}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-testid={`${testIdPrefix}-actions`}
          onPointerDown={(event) => {
            // Another row's menu dismisses on this pointerdown and swallows
            // the click that completes it, so opening on click alone would
            // cost the user a second press when switching between rows.
            if (
              !open &&
              menuDismissalSwallowsClick(
                event.currentTarget.ownerDocument,
                event.target,
              )
            )
              setOpen(true);
          }}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          <MoreHorizontalIcon size="sm" aria-hidden="true" />
        </Button>
      </span>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-label={`Actions for ${itemName}`}
        data-testid={`${testIdPrefix}-menu`}
        className="w-48"
        onClick={(event) => event.stopPropagation()}
      >
        <ActionMenuRowStyle>
          <DropdownMenuItem
            disabled={busy || restoreBlocked}
            aria-describedby={restoreBlocked ? reasonId : undefined}
            data-testid={`${testIdPrefix}-restore`}
            onClick={() => {
              setOpen(false);
              onRestore();
            }}
          >
            <DropdownMenuItemIcon>
              <RefreshIcon />
            </DropdownMenuItemIcon>
            Restore
          </DropdownMenuItem>
          {restoreBlocked && (
            <DropdownMenuLabel
              id={reasonId}
              role="note"
              data-testid={`${testIdPrefix}-restore-reason`}
              className="whitespace-normal"
            >
              {restoreBlockedReason}
            </DropdownMenuLabel>
          )}
          {/* The removal rows close the menu in their own group. */}
          <DropdownMenuDivider />
          <DropdownMenuItem
            disabled={busy}
            data-testid={`${testIdPrefix}-state`}
            onClick={() => {
              setOpen(false);
              onToggleState();
            }}
          >
            <DropdownMenuItemIcon>
              {archived ? <TrashIcon /> : <ArchiveIcon />}
            </DropdownMenuItemIcon>
            {archived ? 'Delete' : 'Archive'}
          </DropdownMenuItem>
          <DropdownMenuItem
            tone="destructive"
            disabled={busy}
            data-testid={`${testIdPrefix}-delete`}
            onClick={() => {
              setOpen(false);
              onDeletePermanently();
            }}
          >
            <DropdownMenuItemIcon>
              <TrashPermanentlyIcon />
            </DropdownMenuItemIcon>
            Delete permanently
          </DropdownMenuItem>
        </ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
}
