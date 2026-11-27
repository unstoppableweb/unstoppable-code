import type {
  PreferencesData,
  PreferencesSaveResult,
} from '@canopy/desktop-shared/types';

/**
 * Browser-event channel name used to broadcast preference changes between
 * components in the same renderer (e.g. Settings → Sidebar) without going
 * through the persistence layer.
 *
 * Subscribers receive a normalized {@link PreferencesData} object so they can
 * update local state immediately, in lockstep with whatever was persisted.
 */
export const CANOPY_PREFERENCES_UPDATED_EVENT = 'canopy:preferences-updated';

function isPreferencesData(value: unknown): value is PreferencesData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'showDiagnosticsPill' in value &&
    typeof value.showDiagnosticsPill === 'boolean'
  );
}

/**
 * Emit a normalized preferences object so listeners can update their local
 * state without a reload. The event detail must be the full
 * {@link PreferencesData} shape so subscribers can resolve any field.
 * An unconfirmed save reply is not emitted: listeners take every field as
 * saved, and only its client-local keys are (`PreferencesSaveResult`).
 */
export function emitPreferencesUpdated(
  preferences: PreferencesData | PreferencesSaveResult,
): void {
  if (typeof window === 'undefined') return;
  if (
    '__preferencesUnconfirmed' in preferences &&
    preferences.__preferencesUnconfirmed === true
  )
    return;
  window.dispatchEvent(
    new CustomEvent<PreferencesData>(CANOPY_PREFERENCES_UPDATED_EVENT, {
      detail: preferences,
    }),
  );
}

/**
 * Subscribe to {@link CANOPY_PREFERENCES_UPDATED_EVENT}. Returns a cleanup
 * function that removes the listener. Safe to call from React effects.
 */
export function subscribePreferencesUpdated(
  listener: (preferences: PreferencesData) => void,
): () => void {
  if (typeof window === 'undefined') {
    return (): void => {};
  }
  const handler = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    if (isPreferencesData(event.detail)) {
      listener(event.detail);
    }
  };
  window.addEventListener(CANOPY_PREFERENCES_UPDATED_EVENT, handler);
  return (): void => {
    window.removeEventListener(CANOPY_PREFERENCES_UPDATED_EVENT, handler);
  };
}
