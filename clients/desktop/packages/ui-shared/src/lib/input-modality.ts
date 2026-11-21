/**
 * Last input modality per document, so focus handlers can apply native
 * `:focus-visible` semantics: react to focus that the user reached by keyboard
 * (Tab, arrows, Enter/Space, Escape …), never to focus that followed a pointer
 * press or that a script moved with `.focus()`.
 *
 * Why not `element.matches(':focus-visible')`? Two reasons. jsdom matches it
 * for every focused element, so tests could never tell keyboard focus from
 * programmatic focus. And Chromium matches it for programmatic focus that
 * happens before any user interaction (page load, `autofocus`), which is
 * precisely the case tooltip triggers must stay quiet for. Tracking the
 * user's last input event is the reliable signal, so it is authoritative here.
 *
 * Tracking installs once per `Document`, in the capture phase so a bubbling
 * listener that stops propagation cannot starve it. Components that consult
 * `wasFocusVisible` call `trackInputModality` when they mount: the first query
 * also installs it, but by then the Tab press that caused that first focus has
 * already happened and would be missed. Keydowns carrying
 * Ctrl/Meta/Alt are app shortcuts rather than focus navigation and are ignored,
 * mirroring the `:focus-visible` heuristic. Once the user is driving by
 * keyboard, scripted focus moves (a menu returning focus to its trigger after
 * Escape) still count as visible until the pointer is used again — the same
 * rule browsers apply.
 */
type InputModality = 'keyboard' | 'pointer';

const POINTER_EVENTS = ['pointerdown', 'mousedown', 'touchstart'] as const;

const modalityByDocument = new WeakMap<Document, InputModality | null>();

/** Menu rows {@link focusMenuRow} focused without painting them. */
const unpaintedRows = new WeakSet<HTMLElement>();

/** Chromium's `focusVisible` focus option, not yet in TypeScript's DOM lib. */
interface FocusVisibleOptions extends FocusOptions {
  readonly focusVisible?: boolean;
}

const MENU_CONTAINER_SELECTOR = '[role="menu"], [role="listbox"]';

/**
 * Paints an unpainted menu row as keyboard focus. A row that already holds
 * focus cannot be repainted by focusing it again, so focus passes through
 * its menu (lent a tabindex for the moment if it has none), then returns.
 */
function paintRow(row: HTMLElement, container: HTMLElement): void {
  unpaintedRows.delete(row);
  const lentTabIndex = !container.hasAttribute('tabindex');
  if (lentTabIndex) container.tabIndex = -1;
  container.focus({ preventScroll: true });
  row.focus({ preventScroll: true });
  if (lentTabIndex) container.removeAttribute('tabindex');
}

/**
 * Whether `value` is an HTML element of `doc`'s window. A pulled-out panel
 * window has its own `HTMLElement`, so the global one would miss its rows.
 */
function isHtmlElementOf(doc: Document, value: unknown): value is HTMLElement {
  const view = doc.defaultView;
  return view !== null && value instanceof view.HTMLElement;
}

function handleUnpaintedRowKeyDown(doc: Document, event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const row = doc.activeElement;
  if (!isHtmlElementOf(doc, row) || !unpaintedRows.has(row)) return;
  const container = row.parentElement?.closest<HTMLElement>(
    MENU_CONTAINER_SELECTOR,
  );
  if (!container) {
    unpaintedRows.delete(row);
    return;
  }
  // The first arrow after a pointer open paints the row that already holds
  // focus, as a native menu does, instead of moving past it. The menu's own
  // handler never sees this key.
  event.preventDefault();
  event.stopPropagation();
  paintRow(row, container);
}

const touchPointerByDocument = new WeakMap<Document, boolean>();

/**
 * Starts recording input modality for `doc`. Idempotent; call it from a mount
 * effect of any component whose focus handler reads `wasFocusVisible`, so the
 * keydown that precedes the user's first keyboard focus is seen.
 */
export function trackInputModality(doc: Document): void {
  if (modalityByDocument.has(doc)) return;
  modalityByDocument.set(doc, null);
  doc.addEventListener(
    'keydown',
    (event: KeyboardEvent): void => handleUnpaintedRowKeyDown(doc, event),
    true,
  );
  doc.addEventListener(
    'focusout',
    (event: FocusEvent): void => {
      if (isHtmlElementOf(doc, event.target))
        unpaintedRows.delete(event.target);
    },
    true,
  );
  doc.addEventListener(
    'keydown',
    (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      modalityByDocument.set(doc, 'keyboard');
    },
    true,
  );
  for (const type of ['pointerdown', 'pointermove'] as const) {
    doc.addEventListener(
      type,
      (event: PointerEvent): void => {
        touchPointerByDocument.set(doc, event.pointerType === 'touch');
      },
      true,
    );
  }
  for (const type of POINTER_EVENTS) {
    doc.addEventListener(
      type,
      (): void => {
        modalityByDocument.set(doc, 'pointer');
      },
      true,
    );
  }
}

/**
 * Whether the last pointer in `doc` was a finger. A tap is followed by the
 * browser's emulated `mouseenter`, which a hover-only tooltip must ignore;
 * reads `false` until `trackInputModality(doc)` has run.
 */
export function lastPointerWasTouch(doc: Document | undefined): boolean {
  return doc !== undefined && touchPointerByDocument.get(doc) === true;
}

/**
 * Whether focus landing on `target` was reached by keyboard. Call it from a
 * focus handler; it reads the modality of the last input event in `target`'s
 * document, so pointer-driven and programmatic focus both report `false`.
 */
export function wasFocusVisible(target: Element): boolean {
  const doc = target.ownerDocument;
  trackInputModality(doc);
  return modalityByDocument.get(doc) === 'keyboard';
}

/**
 * Whether the last input in `target`'s document was a pointer press. Unlike
 * `!wasFocusVisible`, it is false before any recorded input, so a script
 * that moves focus before the user has done anything is not mistaken for a
 * click.
 */
export function wasPointerInput(target: Element): boolean {
  const doc = target.ownerDocument;
  trackInputModality(doc);
  return modalityByDocument.get(doc) === 'pointer';
}

/**
 * Focuses a menu, picker or context-menu row that its menu chose on opening
 * (the first or the selected row). Every menu that moves focus into itself
 * on open goes through here, so they all follow one rule:
 *
 * - Opened from the keyboard, the row is painted at once, like hover.
 * - Opened with a pointer (a click, a right-click), the row takes focus so
 *   the arrows and Enter work immediately, but it is not painted. Chromium
 *   would otherwise carry a visible focus over from the element focused
 *   before (the composer), and a row would look selected under a click. The
 *   first ArrowDown or ArrowUp then paints that row rather than moving.
 *
 * Arrow-key moves inside an open menu use a plain `focus()`; they are
 * keyboard focus and always paint.
 */
export function focusMenuRow(
  row: HTMLElement,
  options: FocusOptions = {},
): void {
  trackInputModality(row.ownerDocument);
  const pointer = wasPointerInput(row);
  const focusOptions: FocusVisibleOptions = pointer
    ? { ...options, focusVisible: false }
    : options;
  row.focus(focusOptions);
  if (pointer && row.ownerDocument.activeElement === row) {
    unpaintedRows.add(row);
  }
}

/**
 * Forgets the recorded modality for `doc` (listeners stay installed). Test
 * helper: jsdom shares one document across a file's cases, so a keydown in one
 * case would otherwise leak keyboard modality into the next.
 */
export function resetInputModality(doc: Document): void {
  trackInputModality(doc);
  modalityByDocument.set(doc, null);
}

// Record from the first input on, so a menu that mounts after the press that
// opened it (a right-click menu) still knows it was a pointer open. Only a
// real DOM document: server rendering has none, and some tests stand in a
// plain object for it.
if (
  typeof document !== 'undefined' &&
  typeof document.addEventListener === 'function'
) {
  trackInputModality(document);
}
