import type { PreferencesCodec } from '@canopy/core-runtime/node/preferences';
import {
  normalizeGitHubStarPromptRecord,
  normalizePlanModeHintRecord,
} from '@canopy/protocol/onboarding';
import { DEFAULT_DOMAIN_PREFERENCES } from './defaults';
import { normalizeDomainPreferences } from './normalize-preferences';
import type { DomainPreferencesData } from './client-local-preferences';
import { mergePreferenceUpdate } from './merge-preference-update';

export function inspectPreferencesPayload(
  payload: Record<string, unknown>,
): string | null {
  if (
    payload.githubStarPrompt !== undefined &&
    normalizeGitHubStarPromptRecord(payload.githubStarPrompt) === undefined
  ) {
    // As above: keep the original file, hide the prompt, refuse its updates.
    return 'GitHub star prompt preferences contain an invalid or unsupported record.';
  }
  if (
    payload.planModeHint !== undefined &&
    normalizePlanModeHintRecord(payload.planModeHint) === undefined
  ) {
    // Leave the original file intact. The renderer's existing __error gate
    // hides the lesson, and hint updates must refuse this degraded snapshot.
    return 'Plan mode hint preferences contain an invalid or unsupported record.';
  }
  return null;
}
/**
 * The domain preferences document's codec: no client-local key (CAN-4472).
 * The desktop store wraps it with `preserveStoredKeys`.
 */
export const DESKTOP_PREFERENCES_CODEC: PreferencesCodec<DomainPreferencesData> =
  {
    defaults: DEFAULT_DOMAIN_PREFERENCES,
    normalize: (payload, view) => normalizeDomainPreferences(payload, view),
    project: (value) => normalizeDomainPreferences(value),
    inspect: inspectPreferencesPayload,
    merge: (existing, patch, context) =>
      mergePreferenceUpdate(existing, patch, context),
  };
