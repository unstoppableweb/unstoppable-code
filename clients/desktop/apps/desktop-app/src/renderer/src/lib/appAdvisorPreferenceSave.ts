import type { PreferencesData } from '@canopy/desktop-shared/types';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';

export function saveAppAdvisorPreferencePatch(
  current: PreferencesData,
  patch: Partial<PreferencesData>,
  onPrefs: (prefs: PreferencesData) => void,
): void {
  const next = { ...current, ...patch };
  onPrefs(next);
  void window.api
    .savePreferences(patch, { view: 'persisted' })
    .then((saved) => {
      // An unconfirmed reply's domain keys are stand-ins (PreferencesSaveResult).
      if (saved.__preferencesUnconfirmed !== true) onPrefs(saved);
      return window.api.loadPreferences();
    })
    .then((runtime) => {
      useAppAdvisorStore.getState().applyPreferences(runtime);
    })
    .catch(() => {
      // Swallow — preference save can fail if userData is unavailable.
    });
}
