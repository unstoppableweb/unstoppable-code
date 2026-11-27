/**
 * The shared definition of "focusable" used by `DialogModal` and
 * `Menu`.
 *
 * Not yet every focus-managing surface in the package — `WorktreeDialogs` still
 * carries its own selector with different rules. Folding it in is worthwhile
 * but is not this change's business.
 *
 * There used to be two: `Menu`'s and `DialogModal`'s, with quietly
 * different rules — one excluded `aria-disabled="true"`, the other did not; one
 * read the `tabindex` attribute, the other the `tabIndex` property (which
 * reports 0 for a `<button>` with no attribute, so the two disagree about
 * plain buttons the moment anything sets `tabindex="-1"` dynamically). Two
 * focus traps in one package that disagree about what is focusable will drift,
 * and the symptom is a surface that traps Tab onto nothing.
 *
 * Deliberately narrower than a full focusability check: this answers "what are
 * the Tab stops inside this surface", not "what could receive focus at all".
 * A stop hidden inside the surface (a kept-mounted page under `hidden`, an
 * `invisible` wrapper) is not one.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  // A player's native controls take Tab inside the element itself.
  'audio[controls]',
  'video[controls]',
  '[tabindex]',
].join(',');

/** Adopted elements retain their original realm's prototype. */
export function isFocusReturnTarget(
  target: Element | null,
): target is Element & Pick<HTMLElement, 'focus'> {
  return (
    target !== null && 'focus' in target && typeof target.focus === 'function'
  );
}

/**
 * Focusable descendants of `root`, in DOM order, excluding `root` itself.
 *
 * `root` is excluded because focus containers carry `tabindex="-1"` so they can
 * be focused programmatically; letting the container become a cycle target
 * would make Tab appear to do nothing.
 *
 * Cross-realm safe: elements are matched by selector rather than by
 * `instanceof`, so a surface rendered into an `ownerDocument` from another
 * window (an iframe, or a second Electron window) is handled correctly. A
 * global `instanceof HTMLElement` check silently returns nothing there.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((item) => item !== root)
    .filter((item) => item.getAttribute('tabindex') !== '-1')
    .filter(
      (item) =>
        !item.hasAttribute('disabled') &&
        item.getAttribute('aria-disabled') !== 'true',
    )
    .filter((item) => !isHiddenWithin(item, root));
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Matched by tag name, not `instanceof`, for the cross-realm reason above. */
function isTextEntry(item: HTMLElement): boolean {
  if (item.tagName === 'TEXTAREA') return true;
  if (item.tagName === 'INPUT') {
    return !NON_TEXT_INPUT_TYPES.has(
      (item.getAttribute('type') ?? 'text').toLowerCase(),
    );
  }
  return item.isContentEditable;
}

/**
 * The element a surface focuses when it opens. On a touch screen a focused
 * text field opens the keyboard before the user has asked to type, so the
 * first other stop in `focusables` takes focus instead, when there is one.
 */
export function openingFocusTarget(
  preferred: HTMLElement | undefined,
  focusables: readonly HTMLElement[],
): HTMLElement | undefined {
  if (preferred === undefined || !isTextEntry(preferred)) return preferred;
  if (!isCoarsePointer(preferred.ownerDocument)) return preferred;
  return focusables.find((item) => !isTextEntry(item)) ?? preferred;
}

/** The primary pointer is coarse (touch); false where it can't be known. */
export function isCoarsePointer(doc: Document | undefined): boolean {
  const view = (doc ?? globalThis.document)?.defaultView;
  return (
    typeof view?.matchMedia === 'function' &&
    view.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * The item cannot take focus because something inside `root` hides it: a
 * `hidden` or `inert` ancestor (a kept-mounted page that is not showing),
 * `display: none`, or `visibility: hidden` (an `invisible` wrapper). Only
 * ancestors inside `root` count, so a surface that is itself inside an inert
 * region keeps its own stops. `checkVisibility` answers for layout where the
 * browser has it; jsdom does not, so the attribute check carries the tests.
 */
function isHiddenWithin(item: HTMLElement, root: HTMLElement): boolean {
  const hiding = item.closest('[hidden],[inert]');
  if (hiding !== null && hiding !== root && root.contains(hiding)) return true;
  if (typeof item.checkVisibility === 'function') {
    return !item.checkVisibility({ visibilityProperty: true });
  }
  return false;
}
