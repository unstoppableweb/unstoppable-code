/**
 * Left-nav entry point for an overview page: a workspace's "Archived and
 * deleted" overview, and the recipient's "Past shares". Pure and
 * callback-driven so code, cowork, and App Advisor surfaces share one visual
 * implementation.
 */
import type { JSX } from 'react';
import { ArrowUpRight } from '../icons/AppIcons';
import {
  SIDEBAR_ROW_GRID_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
  SIDEBAR_ROW_TRAILING_CELL_CLASSNAME,
} from './sidebar-item-classes';

export interface SidebarOverviewNavLinkProps {
  /** The page the link opens, as it reads in the sidebar. */
  label: string;
  /** Items on the page; omit when the count is unknown to keep the link visible. */
  count?: number;
  /** Highlight while this workspace's overview or a viewer on it is open. */
  selected: boolean;
  onOpen: () => void;
  testId: string;
  /**
   * `compact` (default) is the 28px link. `row` takes the sidebar rows' 32px
   * height and `rounded-row` corner, so it lines up with every other item in
   * the desktop sidebar under early access. `item` is a plain sidebar item:
   * the row's size, the rows' 14px title type and no leading glyph, so it
   * reads like the rows above it.
   */
  size?: 'compact' | 'row' | 'item';
}

/**
 * Sits between the label and the count. A flex container renders no box for
 * whitespace between its items, so this changes nothing on screen; it keeps
 * the link's text and accessible name reading "Archived and deleted 3" rather
 * than "Archived and deleted3".
 */
const LABEL_COUNT_SEPARATOR = ' ';

export function SidebarOverviewNavLink({
  label,
  count,
  selected,
  onOpen,
  testId,
  size = 'compact',
}: SidebarOverviewNavLinkProps): JSX.Element | null {
  // Nothing on the page: no link, unless the page is open.
  if (count !== undefined && count <= 0 && !selected) {
    return null;
  }
  const rowSized = size !== 'compact';
  return (
    // `row` keeps the rows' own 1px rhythm above it; the compact link keeps
    // its 4px.
    <div
      className={rowSized ? 'mt-px' : 'mt-1'}
      data-testid={`${testId}-section`}
    >
      <button
        type="button"
        data-testid={testId}
        data-selected={selected ? 'true' : 'false'}
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}
        // The task rows' grid: the same left inset, leading icon column, and
        // gap as the rows above, so the glyph sits under their icons and the
        // label under their titles. Both sizes take the rows' right inset, so
        // the count sits under their ages and the count beside the project
        // name.
        className={`focus-ring flex pr-1.5 ${rowSized ? 'h-8 rounded-row' : 'h-7 rounded-md'} w-full items-center ${SIDEBAR_ROW_GRID_CLASSNAME} text-left ${size === 'item' ? 'text-s leading-snug' : 'text-xs'} transition-colors ${
          selected
            ? 'bg-fg-primary/[0.08] fg-primary'
            : 'fg-secondary hover:bg-fg-primary/[0.04] hover:fg-primary'
        }`}
      >
        <span className={SIDEBAR_ROW_LEADING_SLOT_CLASSNAME} aria-hidden="true">
          {size === 'item' ? null : <ArrowUpRight size={12} />}
        </span>
        <span className="min-w-0 truncate" data-testid={`${testId}-label`}>
          {label}
        </span>
        {LABEL_COUNT_SEPARATOR}
        {/* The rows' age cell, so the count shares one right edge, ink and
            type with the ages above it. */}
        {count !== undefined && (
          <span
            className={SIDEBAR_ROW_TRAILING_CELL_CLASSNAME}
            data-testid={`${testId}-count`}
          >
            {count}
          </span>
        )}
      </button>
    </div>
  );
}

export interface ArchivedContainersNavLinkProps extends Omit<
  SidebarOverviewNavLinkProps,
  'label' | 'count'
> {
  /** Retained items, omitted when the host has no complete archive count. */
  count?: number;
}

export function ArchivedContainersNavLink(
  props: ArchivedContainersNavLinkProps,
): JSX.Element | null {
  return <SidebarOverviewNavLink label="Archived and deleted" {...props} />;
}

export interface MoreRowProps extends Omit<
  SidebarOverviewNavLinkProps,
  'label' | 'size'
> {
  /** Hidden, archived and deleted items in the project. */
  count: number;
}

/**
 * A project's "More" row: a plain sidebar item that opens its More page
 * (hidden, archived and deleted worktrees). Its label lines up with the
 * titles above and its count sits in the rows' trailing cell.
 */
export function MoreRow(props: MoreRowProps): JSX.Element | null {
  return <SidebarOverviewNavLink label="More" size="item" {...props} />;
}
