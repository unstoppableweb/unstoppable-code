'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import { Button } from '../primitives/Button';
import { RailIconButton } from './RailIconButton';
import { DropdownMenuSurface } from '../primitives/DropdownMenu';
import { FloatingMenu } from '../primitives/FloatingMenu';
import {
  WorktreeActionMenuItems,
  type WorktreeMenuItem,
} from './WorktreeActionsMenu';
import {
  ArchiveIcon,
  CloseIcon,
  ListChecks,
  MoreHorizontalIcon,
  PinIcon,
} from '../icons/AppIcons';

export interface SidebarSelectionHeaderActionsProps {
  readonly projects?: boolean;
  readonly allSelected: boolean;
  readonly onToggleAll: () => void;
  readonly onDone: () => void;
}

export function SidebarSelectionHeaderActions({
  projects,
  allSelected,
  onToggleAll,
  onDone,
}: SidebarSelectionHeaderActionsProps): JSX.Element {
  return (
    <span
      className={`ml-auto flex shrink-0 items-center gap-px ${projects ? 'translate-y-0.5' : ''}`}
      data-sidebar-selection-keeper=""
    >
      <RailIconButton
        icon={ListChecks}
        aria-label={allSelected ? 'Select none' : 'Select all'}
        aria-pressed={allSelected}
        tone="section"
        hoverSurface
        onClick={onToggleAll}
      />
      <Button
        variant="ghost"
        size="compact"
        iconShape="nested"
        touchArea="contained"
        onClick={onDone}
      >
        Done
      </Button>
    </span>
  );
}

/** Mounted through exit so a cleared selection never snaps out of the rail. */
export function SidebarSelectionToolbar({
  count,
  items,
  onCancel,
}: {
  readonly count: number;
  readonly items: readonly WorktreeMenuItem[];
  readonly onCancel: () => void;
}): JSX.Element {
  const visible = count > 0;
  const [moreOpen, setMoreOpen] = useState(false);
  const [lastCount, setLastCount] = useState(count);
  const [lastItems, setLastItems] = useState(items);
  const anchor = useRef<HTMLButtonElement>(null);
  const presence = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible) {
      setLastCount(count);
      setLastItems(items);
    } else setMoreOpen(false);
  }, [visible, count, items]);
  useEffect(() => {
    const document = presence.current?.ownerDocument;
    if (!document) return;
    const setMotion = (event: Event): void => {
      if (presence.current)
        presence.current.dataset.motion =
          event.type === 'keydown' ? 'instant' : 'pointer';
    };
    document.addEventListener('keydown', setMotion, true);
    document.addEventListener('pointerdown', setMotion, true);
    return (): void => {
      document.removeEventListener('keydown', setMotion, true);
      document.removeEventListener('pointerdown', setMotion, true);
    };
  }, []);
  const displayedItems = visible ? items : lastItems;
  const pin = displayedItems.find((item) => item.key === 'bulk-pin');
  const archive = displayedItems.find((item) => item.key === 'bulk-archive');
  const more = displayedItems.filter(
    (item) => item !== pin && item !== archive,
  );
  return (
    <div
      ref={presence}
      className="sidebar-selection-toolbar-presence"
      data-state={visible ? 'open' : 'closed'}
      data-sidebar-selection-keeper=""
      aria-hidden={!visible}
      inert={!visible}
    >
      <DropdownMenuSurface
        // A group, not a toolbar: its buttons are plain Tab stops, with no
        // arrow-key roving.
        role="group"
        aria-label="Selection actions"
        padding="none"
        className="w-full"
      >
        <div className="flex h-9 items-center gap-px px-1 pointer-coarse:h-11">
          <span className="min-w-0 flex-1 truncate pl-1.5 text-xs tabular-nums fg-secondary">
            {visible ? count : lastCount} selected
          </span>
          {more.length > 0 && (
            <RailIconButton
              ref={anchor}
              icon={MoreHorizontalIcon}
              aria-label="More actions"
              tooltipLabel={moreOpen ? '' : 'More actions'}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              tone="secondary"
              coarsePointerTarget
              onClick={(): void => setMoreOpen((open) => !open)}
            />
          )}
          {pin && (
            <RailIconButton
              icon={PinIcon}
              aria-label={pin.label}
              tone="secondary"
              coarsePointerTarget
              disabled={pin.disabled}
              onClick={(): void => pin.onSelect?.()}
            />
          )}
          {archive && (
            <RailIconButton
              icon={ArchiveIcon}
              aria-label={archive.label}
              tone="secondary"
              coarsePointerTarget
              disabled={archive.disabled}
              onClick={(): void => archive.onSelect?.()}
            />
          )}
          <RailIconButton
            icon={CloseIcon}
            aria-label="Cancel selection"
            tone="secondary"
            coarsePointerTarget
            onClick={onCancel}
          />
        </div>
      </DropdownMenuSurface>
      <FloatingMenu
        open={visible && moreOpen}
        onOpenChange={setMoreOpen}
        anchorRef={anchor}
        placement="top-right"
        role="menu"
        aria-label="More selection actions"
      >
        <WorktreeActionMenuItems
          items={more}
          onSelect={(item): void => {
            if (item.role !== 'menuitemradio') setMoreOpen(false);
            item.onSelect?.();
          }}
        />
      </FloatingMenu>
    </div>
  );
}
