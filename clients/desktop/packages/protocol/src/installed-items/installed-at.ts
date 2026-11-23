/**
 * Installed-copy dates (CAN-5239): the first successful installation of the
 * copy a host holds now. The value is optional metadata, so anything that is
 * not a real ISO 8601 instant with an explicit zone is unknown, never an
 * error and never a reason to drop the item it describes.
 */

// Seconds are optional (`2025-04-08T10:15+02:00`), as in ISO 8601 and the
// ECMAScript date-time format; a fraction is only allowed after seconds.
const INSTANT_RE =
  /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

/** Parse optional installed-copy metadata without Date.parse calendar repair. */
export function parseInstalledAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = INSTANT_RE.exec(value);
  if (!match || match[1] === '-000000') return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6] ?? '0') > 59
  )
    return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/** Serialize a valid instant in UTC; malformed optional metadata stays unknown. */
export function normalizeInstalledAt(value: unknown): string | undefined {
  const milliseconds = parseInstalledAt(value);
  return milliseconds === undefined
    ? undefined
    : new Date(milliseconds).toISOString();
}
