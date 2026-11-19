import type {
  CloudDigestPreferences,
  CloudDigestPreferencesState,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_DIGEST_PREFERENCES,
  parseDigestPreferences,
} from '@canopy/protocol/digests';
import { BRAND } from '@canopy/brand/current';
import { CanopyCloudClientError, requestCanopyCloudJson } from './client';

const DIGEST_PREFERENCES_PATH = `/api/v1/${BRAND.web.apiNamespace}/account/digest-preferences`;

/**
 * Every cadence off, from the shared contract the web preferences service uses
 * (digests are opt-in, so an absent row means off). Carried alongside an
 * unavailable/unresolved answer only — the renderer must consult `resolved`
 * before treating these as the account's real setting.
 *
 * Frozen because {@link UNAVAILABLE} and {@link UNRESOLVED} are module-level
 * singletons returned by reference on every failure: without this, one caller
 * mutating `state.preferences` would corrupt the constant for all later ones.
 */
const DEFAULT_PREFERENCES: CloudDigestPreferences = Object.freeze({
  ...DEFAULT_DIGEST_PREFERENCES,
});

const UNAVAILABLE: CloudDigestPreferencesState = Object.freeze({
  available: false,
  resolved: true,
  preferences: DEFAULT_PREFERENCES,
});

const UNRESOLVED: CloudDigestPreferencesState = Object.freeze({
  available: true,
  resolved: false,
  preferences: DEFAULT_PREFERENCES,
});

/**
 * Reads a preferences payload without trusting it, via the shared validator.
 *
 * The route returns the projected `{daily, weekly, monthly}` object, but a
 * partial or renamed response must not be silently coerced into "every cadence
 * off" — that would render three off toggles the user did not choose and then
 * persist them on the next click.
 */
function parsePreferences(value: unknown): CloudDigestPreferences | null {
  return parseDigestPreferences(value);
}

/**
 * Classifies a failure as "this surface does not exist for you" (hide the
 * section) versus "something went wrong" (show an error and keep the section).
 *
 * Unavailable covers three distinct causes with one user-visible outcome:
 * no cloud account connected at all (`cloud-not-configured` /
 * `missing-api-key`, raised before any request goes out); a 404, which is what
 * `requireDigestsEnabled` answers while `canopy-digests-enabled` is off and
 * also what a server predating the digests routes returns; and 401/403, a
 * credential the server will not accept. Every other failure — offline, 5xx,
 * a malformed body — is transient and must NOT be reported as "all cadences
 * off", because the next toggle click would persist that fiction.
 */
function stateForError(error: unknown): CloudDigestPreferencesState {
  if (error instanceof CanopyCloudClientError) {
    if (
      error.code === 'cloud-not-configured' ||
      error.code === 'missing-api-key' ||
      error.status === 404 ||
      error.status === 401 ||
      error.status === 403
    ) {
      return UNAVAILABLE;
    }
  }
  return UNRESOLVED;
}

/**
 * Load the connected cloud account's digest cadences.
 *
 * Deliberately uncached: these are cloud-account settings the user can change
 * from the web at any time, the section is only mounted while the Notifications
 * settings tab is open, and a stale toggle is worse than one extra request.
 */
export async function loadCloudDigestPreferences(): Promise<CloudDigestPreferencesState> {
  try {
    const parsed = parsePreferences(
      await requestCanopyCloudJson<unknown>(DIGEST_PREFERENCES_PATH),
    );
    return parsed
      ? { available: true, resolved: true, preferences: parsed }
      : UNRESOLVED;
  } catch (error) {
    return stateForError(error);
  }
}

/** Write all three cadences and adopt whatever the server projected back. */
export async function saveCloudDigestPreferences(
  preferences: CloudDigestPreferences,
): Promise<CloudDigestPreferencesState> {
  try {
    const parsed = parsePreferences(
      await requestCanopyCloudJson<unknown>(DIGEST_PREFERENCES_PATH, {
        method: 'PATCH',
        body: JSON.stringify(preferences),
      }),
    );
    return parsed
      ? { available: true, resolved: true, preferences: parsed }
      : UNRESOLVED;
  } catch (error) {
    return stateForError(error);
  }
}
