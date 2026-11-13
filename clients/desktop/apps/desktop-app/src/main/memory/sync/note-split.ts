/*
 * Cutting redacted memory text into note-sized pieces, in one place: a
 * conflict's side (design §13.2) and an import note first enable queues
 * (design §17) both go up as ordered notes when they do not fit one.
 *
 * Every caller redacts the whole text before it splits, because a secret
 * over several lines, such as a private key, is found only whole: a cut
 * inside one would leave each half unrecognizable and each piece would pass
 * the scan on its own. These helpers therefore only ever see redacted text,
 * and they keep the markers redaction left intact.
 */

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The marker redaction leaves in place of a secret, such as `<SECRET>`. */
const REDACTION_MARKER = /<[A-Za-z_-]+>/g;

/**
 * Where to cut `line`, longer than `budget` bytes: after the longest prefix
 * that fits, at a code point, and never inside a redaction marker.
 */
function cutWithin(line: string, budget: number): number {
  let bytes = 0;
  let end = 0;
  for (const character of line) {
    const size = utf8Bytes(character);
    if (bytes + size > budget) break;
    bytes += size;
    end += character.length;
  }
  for (const marker of line.matchAll(REDACTION_MARKER)) {
    const start = marker.index;
    if (start >= end) break;
    if (start > 0 && end < start + marker[0].length) return start;
  }
  return end;
}

/** The lines of `text`, each keeping its own line end. */
function lines(text: string): string[] {
  return text.split(/(?<=\n)/);
}

/**
 * `text` in pieces of at most `budget` bytes, split at line ends when it
 * can and inside a line when one line alone is longer.
 */
export function splitWithinBudget(text: string, budget: number): string[] {
  const parts: string[] = [];
  let part = '';
  const flush = (): void => {
    if (part.length > 0) parts.push(part);
    part = '';
  };
  for (const line of lines(text)) {
    if (utf8Bytes(part) + utf8Bytes(line) <= budget) {
      part += line;
      continue;
    }
    flush();
    let rest = line;
    while (utf8Bytes(rest) > budget) {
      const cut = cutWithin(rest, budget);
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    part = rest;
  }
  flush();
  return parts;
}

/**
 * `text` in pieces of at most `budget` bytes, split only at line ends, or
 * null when one line alone is over the budget. For text whose lines are its
 * units, such as a document an import note carries: a piece cut mid-line
 * would read as two broken lines in the memory it is folded into.
 */
export function splitOnLinesWithinBudget(
  text: string,
  budget: number,
): string[] | null {
  const parts: string[] = [];
  let part = '';
  for (const line of lines(text)) {
    if (utf8Bytes(line) > budget) return null;
    if (utf8Bytes(part) + utf8Bytes(line) <= budget) {
      part += line;
      continue;
    }
    if (part.length > 0) parts.push(part);
    part = line;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}
