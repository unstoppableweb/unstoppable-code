/**
 * Section attribute holding the pinned height of a section's sticky head: the
 * prompt and, when its turn has one, the turn's header beneath it. Only
 * scroll math reads it (landing a row below the pinned head); layout never
 * depends on it.
 */
const STICKY_USER_HEIGHT_ATTRIBUTE = 'data-chat-sticky-user-height';

/** Publishes a section's pinned head height, or clears it with `undefined`. */
export function publishStickyUserHeight(
  section: HTMLElement,
  height: string | undefined,
): void {
  if (height === undefined) {
    section.removeAttribute(STICKY_USER_HEIGHT_ATTRIBUTE);
  } else if (section.getAttribute(STICKY_USER_HEIGHT_ATTRIBUTE) !== height) {
    section.setAttribute(STICKY_USER_HEIGHT_ATTRIBUTE, height);
  }
}

/** The pinned head height last published for a section, in pixels. */
export function readStickyUserHeight(section: HTMLElement): number {
  const height = Number.parseFloat(
    section.getAttribute(STICKY_USER_HEIGHT_ATTRIBUTE) ?? '',
  );
  return Number.isFinite(height) ? height : 0;
}
