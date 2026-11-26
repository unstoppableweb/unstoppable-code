export * from './types';

/** The `preferences.json` envelope version this build writes. */
export const PREFERENCES_ENVELOPE_WRITE_VERSION = 1;

/**
 * Envelope versions every preferences reader accepts. Version 2 has version
 * 1's shape; the owner flip (CAN-5722) writes it, and a build may run before
 * or after a flip build on the same profile.
 */
export const PREFERENCES_ENVELOPE_READ_VERSIONS: readonly number[] = [1, 2];

export function isReadablePreferencesEnvelopeVersion(
  version: unknown,
): boolean {
  return PREFERENCES_ENVELOPE_READ_VERSIONS.some(
    (readable) => readable === version,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `preferences` record of a parsed preferences envelope, or null when the
 * envelope is unusable (not a record, an unreadable version, or no
 * `preferences` record). Fields inside are not checked.
 */
export function readPreferencesEnvelopeRecord(
  parsed: unknown,
): Record<string, unknown> | null {
  if (
    !isRecord(parsed) ||
    !isReadablePreferencesEnvelopeVersion(parsed.version) ||
    !isRecord(parsed.preferences)
  ) {
    return null;
  }
  return parsed.preferences;
}
