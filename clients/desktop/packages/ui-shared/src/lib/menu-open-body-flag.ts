/**
 * Body-level "a menu is open" flag, reference-counted across every open menu
 * surface (FloatingMenu, bespoke dropdown portals). While set,
 * the app suppresses hover feedback on inert background surfaces (see the
 * `data-sidebar-menu-open` rules in the desktop globals.css). One shared
 * counter per document keeps overlapping menus from clearing each other's
 * flag.
 */
const countsByDocument = new WeakMap<Document, number>();

type DismissalClickGuard = (target: EventTarget | null) => boolean;
const clickGuardsByDocument = new WeakMap<Document, Set<DismissalClickGuard>>();

/** Open a replacement menu on pointerdown when its click will be consumed. */
export function menuDismissalSwallowsClick(
  doc: Document,
  target: EventTarget | null,
): boolean {
  const guards = clickGuardsByDocument.get(doc);
  return guards ? [...guards].some((guard) => guard(target)) : false;
}

export function registerMenuDismissalClickGuard(
  doc: Document,
  guard: DismissalClickGuard,
): () => void {
  let guards = clickGuardsByDocument.get(doc);
  if (!guards) {
    guards = new Set();
    clickGuardsByDocument.set(doc, guards);
  }
  const registered = guards;
  registered.add(guard);
  return (): void => {
    registered.delete(guard);
  };
}

/**
 * The surfaces whose hover feedback is suppressed while a menu is open, and
 * the attribute that says so on each of them. The style rule keys on this
 * attribute, not on the body flag: a rule under a body attribute that
 * reaches every descendant of a surface made the browser restyle the whole
 * document on each menu open and close.
 */
const HOVER_SUPPRESSED_SURFACE_SELECTOR = '.sidebar-resizable-surface';
const SURFACE_MENU_OPEN_ATTRIBUTE = 'data-menu-open';

function markHoverSuppressedSurfaces(doc: Document, open: boolean): void {
  for (const surface of Array.from(
    doc.querySelectorAll(
      open
        ? HOVER_SUPPRESSED_SURFACE_SELECTOR
        : `[${SURFACE_MENU_OPEN_ATTRIBUTE}]`,
    ),
  )) {
    if (open) surface.setAttribute(SURFACE_MENU_OPEN_ATTRIBUTE, '');
    else surface.removeAttribute(SURFACE_MENU_OPEN_ATTRIBUTE);
  }
}

export function pushMenuOpenBodyFlag(doc: Document): () => void {
  countsByDocument.set(doc, (countsByDocument.get(doc) ?? 0) + 1);
  doc.body.dataset.sidebarMenuOpen = 'true';
  // Each push marks again, so a surface mounted since the last one joins.
  markHoverSuppressedSurfaces(doc, true);
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    const next = Math.max(0, (countsByDocument.get(doc) ?? 1) - 1);
    countsByDocument.set(doc, next);
    if (next === 0) {
      delete doc.body.dataset.sidebarMenuOpen;
      markHoverSuppressedSurfaces(doc, false);
    }
  };
}
