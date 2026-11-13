/**
 * Drawer item controls appear on demand: a drawer row's actions (Open, Stop,
 * Steer, Delete) and a drawer card's header actions (View tree, Stop all)
 * stay transparent until their row or card is hovered or holds keyboard
 * focus, and always show on touch, where hover does not exist. They keep
 * their space, so times and labels line up whether or not they show, and
 * they stay in the tab order. An open menu keeps its trigger shown. The
 * reveal is instant, with no fade, so a control is there the moment the
 * pointer is (design decision, 2026-11-10).
 *
 * The row and the card name different groups, so hovering a card does not
 * reveal every row's actions at once. Tailwind only generates classes it
 * finds whole in source, so each is written out.
 */
export const DRAWER_ITEM_GROUP_CLASS = 'group/drawer-item';

export const DRAWER_ITEM_ACTIONS_CLASS =
  'opacity-0 group-hover/drawer-item:opacity-100 group-focus-within/drawer-item:opacity-100 group-data-[dragging]/drawer-item:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100';

export const DRAWER_CARD_GROUP_CLASS = 'group/drawer-card';

export const DRAWER_CARD_ACTIONS_CLASS =
  'opacity-0 group-hover/drawer-card:opacity-100 group-focus-within/drawer-card:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100';
