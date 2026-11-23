/**
 * Keyboard-target predicates shared by the desktop renderer's shortcut
 * routing and the web shell's find shortcut (CAN-3048). Structural checks
 * rather than `instanceof`, so targets from a popped-out panel window (another
 * realm) still qualify.
 */

import { isMacPlatform } from '@canopy/ui-shared/lib/shortcut-platform';
import { PANEL_CONTENT_HOST_ATTRIBUTE } from '@canopy/ui-shared/panels';

// One platform check for matching and hint display, owned by the shared
// shortcut registry.
export { isMacPlatform };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ClosestCapableTarget {
  closest: (selector: string) => unknown;
}

interface OwnerDocumentCapableTarget {
  ownerDocument: Document;
}

/**
 * Structural `Element`-ish check for an `EventTarget`.
 *
 * Shared by every shortcut-routing predicate in the app so target narrowing
 * happens in one place, as a type guard rather than an `as` cast (CAN-2309).
 * It is deliberately structural: an `instanceof Element` test is realm-bound
 * and returns false for targets originating in a popped-out panel window.
 */
export function hasClosestMethod(
  value: unknown,
): value is ClosestCapableTarget {
  return isRecord(value) && typeof value.closest === 'function';
}

function hasOwnerDocument(value: unknown): value is OwnerDocumentCapableTarget {
  return isRecord(value) && isRecord(value.ownerDocument);
}

/**
 * The document owning an event target, or `null` when the target has none
 * (the `Document` itself, or `window`). Structural for the realm reason
 * above — `instanceof Document` would silently report the main document for a
 * popped-out panel window's nodes.
 */
export function readTargetOwnerDocument(
  value: EventTarget | null,
): Document | null {
  return hasOwnerDocument(value) ? value.ownerDocument : null;
}

export interface ShortcutEventLike {
  altKey: boolean;
  code?: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export function isShortcutEvent(
  event: ShortcutEventLike,
  key: string,
  opts?: { shift?: boolean; alt?: boolean },
): boolean {
  if (event.isComposing) {
    return false;
  }

  // Alt participates as an explicit opt-in modifier. Only non-character keys
  // (arrows) should bind with alt: on macOS, Option+<letter> composes special
  // characters and changes `event.key`.
  const expectsAlt = opts?.alt === true;
  if (event.altKey !== expectsAlt) {
    return false;
  }

  const expectsShift = opts?.shift === true;
  if (event.shiftKey !== expectsShift) {
    return false;
  }

  const normalizedKey = event.key.toLowerCase();
  if (normalizedKey !== key.toLowerCase()) {
    return false;
  }

  return isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * True when the event target sits inside a modal dialog (Quick Prompt,
 * review/plan search overlays, task forms, ...). Used by the global shortcut
 * handler: chords that deliberately run before the editable-target guard
 * (⌘1–9/T/N/W) must not fire from a dialog's editor — they would mutate or
 * navigate the page hidden behind the overlay.
 */
export function isDialogTarget(target: EventTarget | null): boolean {
  if (!hasClosestMethod(target)) {
    return false;
  }

  return target.closest('[role="dialog"], [aria-modal="true"]') !== null;
}

/**
 * Whether a panel chord (close tab, tab cycling) would act behind a modal.
 * The chords act on the focused group's selected panel (`actingPanelId`), not
 * on wherever focus sits, and focus can fall to the page while a modal is
 * open, as it does once the media viewer's picture or a dialog's scrim is
 * clicked. So: focus inside any dialog holds the chord, and so does a modal
 * that covers the window. One contained in a panel (a `DialogModal` with
 * `containment="parent"`, such as the browser pane's sign-in) holds it only
 * when it sits in the panel the chord acts on: another group keeps its
 * chords, and a dialog left open in a background tab holds nothing. With no
 * selected panel to act on (`actingPanelId` null), no contained modal is in
 * it, so none holds.
 */
export function isBehindModal(
  target: EventTarget | null,
  ownerDocument: Document,
  actingPanelId: string | null,
): boolean {
  if (isDialogTarget(target)) return true;
  for (const modal of ownerDocument.querySelectorAll('[aria-modal="true"]')) {
    const contained = modal.closest(
      '[data-canopy-overlay-containment="parent"]',
    );
    if (contained === null) return true;
    // Every panel's content sits in its own host, hidden tabs included.
    const host = contained.closest(`[${PANEL_CONTENT_HOST_ATTRIBUTE}]`);
    // A contained modal outside any panel cannot be placed: hold.
    if (host === null) return true;
    if (host.getAttribute(PANEL_CONTENT_HOST_ATTRIBUTE) === actingPanelId) {
      return true;
    }
  }
  return false;
}
