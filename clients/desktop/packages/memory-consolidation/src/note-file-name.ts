/*
 * The file name of a saved memory note, shared by the desktop store and
 * Canopy Cloud so a note saved in either place gets the same kind of name
 * (CAN-6314).
 */

export function memoryNoteSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'note';
}

/** The last millisecond whose ISO year has four digits. */
const LAST_FOUR_DIGIT_YEAR_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function filenameTimestamp(timeMs: number): string {
  const clamped = Number.isFinite(timeMs)
    ? Math.min(Math.max(timeMs, 0), LAST_FOUR_DIGIT_YEAR_MS)
    : 0;
  return new Date(clamped).toISOString().slice(0, 19).replace(/:/g, '-');
}

/**
 * `<created>-<slug>-<last 6 of the ID, lower>.md`: two devices saving the
 * same text in the same second still mint different names.
 */
export function memoryNoteFileName(
  createdMs: number,
  slugSource: string,
  noteId: string,
): string {
  return `${filenameTimestamp(createdMs)}-${memoryNoteSlug(slugSource)}-${noteId.slice(-6).toLowerCase()}.md`;
}
