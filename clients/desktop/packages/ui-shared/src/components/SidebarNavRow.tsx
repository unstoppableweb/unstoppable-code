'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
  SIDEBAR_LIST_ICON_CLASSNAME,
  SIDEBAR_NAV_ITEM_CLASSNAME,
  SIDEBAR_NAV_ROW_TRAILING_INSET_CLASSNAME,
} from '../primitives/sidebar-item-classes';

/** A run state the row reports on its leading glyph. */
export type SidebarNavRowStatus = 'active' | 'unread' | 'success' | 'failed';

export interface SidebarNavRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly selected?: boolean;
  /** Back and other quiet navigation controls use secondary ink. */
  readonly tone?: 'default' | 'secondary';
  /**
   * Inks the leading glyph with the status color instead of `fg-secondary`.
   * The row background is reserved for selection.
   */
  readonly status?: SidebarNavRowStatus;
  readonly iconClassName?: string;
  /** Raise labeled rows to 44px for touch layouts. */
  readonly touchTarget?: 'coarse' | 'always' | 'none';
  /**
   * Keys that perform the row's action (`formatShortcut(id)`), trailing the
   * label as plain glyphs in the quietest ink, as a native menu draws them.
   * Hidden until the row is hovered or keyboard-focused; it keeps its space,
   * so the row never resizes or shifts.
   */
  readonly shortcut?: string;
}

/** Canonical navigation row shared by the main and settings sidebars. */
export const SidebarNavRow = forwardRef<HTMLButtonElement, SidebarNavRowProps>(
  function SidebarNavRow(
    {
      icon,
      children,
      selected = false,
      tone = 'default',
      status,
      iconClassName = '',
      touchTarget = 'coarse',
      shortcut,
      className = '',
      type = 'button',
      ...buttonProps
    },
    ref,
  ): JSX.Element {
    const stateClassName =
      tone === 'secondary'
        ? 'fg-secondary hover:bg-subtle'
        : selected
          ? SIDEBAR_ITEM_SELECTED_CLASSNAME
          : SIDEBAR_ITEM_IDLE_CLASSNAME;
    const iconInkClassName =
      status === undefined
        ? 'fg-secondary'
        : OPERATIONAL_STATUS_COLORS[status].foreground;

    const touchClassName =
      touchTarget === 'always'
        ? 'min-h-11'
        : touchTarget === 'coarse'
          ? 'pointer-coarse:min-h-11'
          : '';
    // Unavailable (New task before its host can create one), the row dims
    // and drops its hover fill like a disabled `Button`.
    const disabledClassName =
      'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';
    return (
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        data-sidebar-nav-row=""
        className={`group/nav-row ${SIDEBAR_NAV_ITEM_CLASSNAME} ${touchClassName} ${stateClassName} ${disabledClassName}${className ? ` ${className}` : ''}`}
      >
        <span
          className={`${SIDEBAR_LIST_ICON_CLASSNAME} ${iconInkClassName}${iconClassName ? ` ${iconClassName}` : ''}`}
        >
          {icon}
        </span>
        {children}
        {shortcut !== undefined && shortcut !== '' && (
          <span
            aria-hidden="true"
            data-testid="sidebar-row-shortcut"
            className={`ml-auto shrink-0 pl-2 ${SIDEBAR_NAV_ROW_TRAILING_INSET_CLASSNAME} text-xs tabular-nums fg-quaternary opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover/nav-row:opacity-100 group-focus-visible/nav-row:opacity-100`}
          >
            {shortcut}
          </span>
        )}
      </button>
    );
  },
);

SidebarNavRow.displayName = 'SidebarNavRow';
