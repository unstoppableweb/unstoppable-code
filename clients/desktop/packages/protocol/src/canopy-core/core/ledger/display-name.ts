import { LEDGER_LIMITS } from './limits';
import { LedgerDisplayNameSchema } from './schemas';

/*
 * Actor display names: what a writer registers an actor under. Every Ledger
 * writer normalizes a host-supplied name the same way before it is stored or
 * synced: the desktop's actor directory and the web core's cloud writer
 * (CAN-6422).
 */

function replaceControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    result +=
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? ' '
        : character;
  }
  return result;
}

/** A single-line display name within the Ledger limit, or the fallback. */
export function toLedgerDisplayName(value: string, fallback: string): string {
  const singleLine = replaceControlCharacters(value).replace(/\s+/g, ' ');
  const bounded = Array.from(singleLine.trim())
    .slice(0, LEDGER_LIMITS.displayNameMaxCodePoints)
    .join('')
    .trim();
  return LedgerDisplayNameSchema.safeParse(bounded).success
    ? bounded
    : fallback;
}
