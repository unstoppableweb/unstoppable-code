import { useId, type JSX, type ReactNode } from 'react';
type SidebarSortMode = 'manual' | 'last-updated';
import {
  MenuDivider,
  MenuItem,
  MenuItemIcon,
  MenuLabel,
  MenuItemTrailing,
} from '../primitives/MenuItem';
import { CheckIcon, ShareIcon, DownloadIcon } from '../icons/AppIcons';

/** Labels for the two ordering modes a sidebar section can be in. */
const SORT_MODE_OPTIONS: { mode: SidebarSortMode; label: string }[] = [
  { mode: 'manual', label: 'Manual order' },
  { mode: 'last-updated', label: 'Last updated' },
];

export interface SidebarSortMenuItemsProps {
  /** Current mode for the section; missing resolves to `'manual'`. */
  mode: SidebarSortMode | undefined;
  onSelect: (mode: SidebarSortMode) => void;
  /** Prefix for each item's `data-testid`, e.g. `sidebar-projects-sort`. */
  testIdPrefix: string;
  /** Heading above the choices. Defaults to "Sort by". */
  label?: string;
  /** Render a divider above the group. */
  divider?: boolean;
  /**
   * Render a divider below the group, for menus that lead with it: every
   * section and project menu puts the sort choice first, then its actions.
   */
  dividerAfter?: boolean;
}

/**
 * The "Sort by" group shared by every sidebar section menu (CAN-1074).
 *
 * `Manual order` is the default and keeps drag-and-drop for the section's
 * unpinned rows, so they stay where the user put them. `Last updated` orders
 * those rows by recency instead. Pinned rows are always manually ordered
 * regardless of the choice, so drag-and-drop is never fully retired.
 */
export function SidebarSortMenuItems({
  mode,
  onSelect,
  testIdPrefix,
  label = 'Sort by',
  divider = true,
  dividerAfter = false,
}: SidebarSortMenuItemsProps): JSX.Element {
  const resolved = mode === 'last-updated' ? mode : 'manual';
  const labelId = useId();
  return (
    <>
      {divider && <MenuDivider />}
      <MenuLabel id={labelId}>{label}</MenuLabel>
      {/* One radio set per heading, read with that heading. */}
      <div role="group" aria-labelledby={labelId} className="contents">
        {SORT_MODE_OPTIONS.map((option) => (
          <MenuItem
            key={option.mode}
            data-testid={`${testIdPrefix}-${option.mode}`}
            aria-checked={resolved === option.mode}
            role="menuitemradio"
            onClick={(): void => onSelect(option.mode)}
          >
            <MenuItemIcon>
              {resolved === option.mode ? <CheckIcon size="md" /> : null}
            </MenuItemIcon>
            <span className="truncate">{option.label}</span>
          </MenuItem>
        ))}
      </div>
      {dividerAfter && <MenuDivider />}
    </>
  );
}

export interface SidebarChatsSectionMenuItemsProps {
  readonly mode?: SidebarSortMode;
  readonly sortLabel?: string;
  readonly onSort: (mode: SidebarSortMode) => void;
  readonly onShare?: () => void;
  readonly onImport?: () => void;
}

export function SidebarChatsSectionMenuItems({
  mode,
  onSort,
  sortLabel = 'Sort chats by',
  onShare,
  onImport,
}: SidebarChatsSectionMenuItemsProps): JSX.Element {
  return (
    <>
      <SidebarSortMenuItems
        mode={mode}
        testIdPrefix="workspace-item-sort"
        label={sortLabel}
        onSelect={onSort}
        divider={false}
        dividerAfter
      />
      <MenuItem
        data-testid="workspace-share-template-menu-item"
        onClick={onShare}
        disabled={!onShare}
      >
        <MenuItemIcon>
          <ShareIcon />
        </MenuItemIcon>
        <span className="truncate">Share template</span>
      </MenuItem>
      <MenuItem
        data-testid="workspace-import-session-menu-item"
        onClick={onImport}
        disabled={!onImport}
      >
        <MenuItemIcon>
          <DownloadIcon />
        </MenuItemIcon>
        <span className="truncate">Import session…</span>
      </MenuItem>
    </>
  );
}

export interface SidebarProjectVisibilityOption {
  readonly id: string;
  readonly name: string;
  readonly worktreeCount: number;
  readonly icon: ReactNode;
}

export interface SidebarProjectVisibilityMenuItemsProps {
  readonly options: readonly SidebarProjectVisibilityOption[];
  readonly hiddenWorkspaceIds: readonly string[];
  readonly onChange: (ids: string[]) => void;
}

export function SidebarProjectVisibilityMenuItems({
  options,
  hiddenWorkspaceIds,
  onChange,
}: SidebarProjectVisibilityMenuItemsProps): JSX.Element | null {
  const labelId = useId();
  if (options.length < 2) return null;
  const hidden = new Set(hiddenWorkspaceIds);
  return (
    <>
      <MenuDivider />
      <MenuLabel id={labelId}>Show projects</MenuLabel>
      <div role="group" aria-labelledby={labelId} className="contents">
        {options.map((option) => {
          const visible = !hidden.has(option.id);
          return (
            <MenuItem
              key={option.id}
              role="menuitemcheckbox"
              aria-checked={visible}
              data-testid={`sidebar-projects-show-${option.id}`}
              onClick={(): void => {
                const next = new Set(hidden);
                if (next.has(option.id)) next.delete(option.id);
                else next.add(option.id);
                onChange([...next]);
              }}
            >
              <MenuItemIcon
                data-testid={`sidebar-projects-show-check-${option.id}`}
              >
                {visible ? <CheckIcon /> : null}
              </MenuItemIcon>
              <MenuItemIcon
                data-testid={`sidebar-projects-show-icon-${option.id}`}
              >
                {option.icon}
              </MenuItemIcon>
              <span
                className="min-w-0 flex-1 truncate"
                data-testid={`sidebar-projects-show-label-${option.id}`}
              >
                {option.name}
              </span>
              <MenuItemTrailing
                data-testid={`sidebar-projects-show-count-${option.id}`}
              >
                {option.worktreeCount}
              </MenuItemTrailing>
            </MenuItem>
          );
        })}
      </div>
    </>
  );
}
