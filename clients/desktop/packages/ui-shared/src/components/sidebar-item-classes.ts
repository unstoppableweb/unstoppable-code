/**
 * Canonical visual treatment for a sidebar list item.
 *
 * Lifted out of the desktop renderer's `sidebar-styles.ts` so the desktop
 * sidebar and the shared `SidebarSurface` the web portal renders describe a
 * row the same way. They had drifted into two vocabularies for one control —
 * the portal drew idle rows `fg-secondary` against desktop's `fg-primary`, and
 * an active row as `bg-accent-subtle fg-accent` against desktop's neutral
 * `bg-muted fg-primary`, so the same navigation read as grey links with one
 * green item on web and as white links with a selected pill on desktop.
 *
 * These are class-name constants rather than a component on purpose: the two
 * hosts still build their own rows (desktop's `SidebarNavRow`, the portal's
 * `SidebarNavItemRow`) because their click/routing seams differ. Sharing the
 * appearance is the part that has to agree, and it is the part that silently
 * diverges.
 */

/** Idle: a sidebar row is primary text, not secondary. */
export const SIDEBAR_ITEM_IDLE_CLASSNAME = 'fg-primary hover:bg-subtle';

/**
 * Selected/current. Neutral by design — the accent colour is reserved for
 * things the user can act on, and every row in the list is equally actionable,
 * so tinting the current one makes it read as the only live entry.
 */
export const SIDEBAR_ITEM_SELECTED_CLASSNAME = 'bg-muted fg-primary';

/** Geometry shared by every sidebar list item, including footer rows. */
export const SIDEBAR_LIST_ITEM_CLASSNAME =
  'focus-ring flex h-8 w-full items-center gap-2 overflow-hidden whitespace-nowrap rounded-row px-2 py-0 text-s font-normal';

export const SIDEBAR_LIST_ICON_CLASSNAME =
  'inline-flex h-4 w-4 shrink-0 items-center justify-center';

/**
 * The trailing label of a sidebar row: a row's age, a project's worktree
 * count, a collapsed group's count, the "Archived and deleted" count, and any
 * other small number at a row's end. One style for all of them, so a column
 * of ages that ends in a count reads as one column: the same size, quiet
 * `fg-quaternary` ink, proportional digits (these are right-aligned labels,
 * not numbers compared digit by digit) and right edge.
 *
 * A fixed 24px cell, one hover action button wide, so the hover Archive button
 * takes exactly this spot and the pin icon beside it stays put when the row's
 * buttons appear. Text sits right-aligned 4px inside the cell, off the row's
 * very edge. The rare labels wider than 24px (`11mo`, `12mo`, `999`, about
 * 27px) spill left into the gap rather than widening the cell, so every title
 * truncates at the same point. h-5 matches the status slots and the title
 * line.
 */
export const SIDEBAR_ROW_TRAILING_CELL_CLASSNAME =
  'ml-auto inline-flex h-5 w-6 shrink-0 items-center justify-end whitespace-nowrap pr-1 text-2xs tabular-nums fg-quaternary';

/**
 * Where a nav row's trailing shortcut hint ends, so New task's `⌘N` lines up
 * with the ages and counts of the list rows below. A list row is inset 6px on
 * the right and its trailing cell sets text 4px inside that (10px in all); a
 * nav row is inset 8px (`px-2` in `SIDEBAR_LIST_ITEM_CLASSNAME`), so the hint
 * adds the 2px difference. Change these together.
 */
export const SIDEBAR_NAV_ROW_TRAILING_INSET_CLASSNAME = 'pr-0.5';

/**
 * The row grid: where a list row's title starts.
 *
 * Every row under a section header (project names, worktrees, chats, shared
 * containers, and the text-only rows between them) puts its title on one
 * column: a 6px left inset, a 20px leading slot, and a 6px gap, so the title
 * starts at 32px (2rem at 100% UI scale). The slot stays reserved when a row
 * has nothing to put in it; a row that drops it starts its title at the
 * section-header edge and reads as a different kind of thing.
 *
 * This tier is separate from the nav rows above
 * (`SIDEBAR_LIST_ITEM_CLASSNAME`: 8px inset, 16px icon, 8px gap) and from
 * section headers, which keep their own 8px edge.
 */

/** Left inset and gap for a row that renders a leading slot. */
export const SIDEBAR_ROW_GRID_CLASSNAME = 'gap-1.5 pl-1.5';

/** The leading slot itself. Render it even when it is empty. */
export const SIDEBAR_ROW_LEADING_SLOT_CLASSNAME =
  'inline-flex h-5 w-5 shrink-0 items-center justify-center';

/**
 * A text-only row (no slot) whose copy sits on the title column. This must
 * equal the grid's inset + leading slot + gap above (6 + 20 + 6 = 32px);
 * change them together.
 */
export const SIDEBAR_ROW_TEXT_INSET_CLASSNAME = 'pl-8';

/** Navigation aliases keep existing call sites descriptive. */
export const SIDEBAR_NAV_ITEM_CLASSNAME = SIDEBAR_LIST_ITEM_CLASSNAME;
export const SIDEBAR_NAV_ICON_CLASSNAME = `${SIDEBAR_LIST_ICON_CLASSNAME} fg-secondary`;

/**
 * One nav row's full class list.
 *
 * `touchTarget` raises the row to the 44px coarse-pointer minimum rather than
 * replacing the height, so a touch layout keeps the same rounding, padding and
 * type as the pointer one.
 */
export function sidebarNavItemClassName(
  selected: boolean,
  touchTarget = false,
): string {
  return `${SIDEBAR_NAV_ITEM_CLASSNAME} ${
    selected ? SIDEBAR_ITEM_SELECTED_CLASSNAME : SIDEBAR_ITEM_IDLE_CLASSNAME
  }${touchTarget ? ' min-h-11' : ''}`;
}

/**
 * One icon-only nav item: the narrow-width sidebar strip that holds Search,
 * the destinations, and More on one line under New task. A 44px square at
 * every pointer, since the strip only appears in phone and tablet layouts.
 * Idle and selected use the row vocabulary above, so the current destination
 * reads the same whether it is a row or an icon.
 */
export function sidebarNavIconItemClassName(selected: boolean): string {
  return `focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-row ${
    selected ? SIDEBAR_ITEM_SELECTED_CLASSNAME : SIDEBAR_ITEM_IDLE_CLASSNAME
  }`;
}
