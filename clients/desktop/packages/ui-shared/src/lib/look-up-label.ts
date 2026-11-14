/**
 * The longest selection a "Look up" menu row quotes before it ends in `…`.
 * The row stays one menu width; the selection itself is on screen.
 */
const LOOK_UP_LABEL_MAX_SELECTION_LENGTH = 24;

/**
 * The label of the macOS dictionary lookup row in a right-click menu, for the
 * selected text: `Look up “word”`. Whitespace runs collapse to one space and
 * a long selection ends in `…`. `null` when the selection has no text.
 *
 * The curly quotes follow the macOS menu row this item stands in for, which
 * quotes the selection the same way.
 */
export function lookUpMenuLabel(selection: string): string | null {
  const text = selection.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  const characters = Array.from(text);
  const quoted =
    characters.length > LOOK_UP_LABEL_MAX_SELECTION_LENGTH
      ? `${characters
          .slice(0, LOOK_UP_LABEL_MAX_SELECTION_LENGTH - 1)
          .join('')
          .trimEnd()}…`
      : text;
  return `Look up “${quoted}”`;
}
