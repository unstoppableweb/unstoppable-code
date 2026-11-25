import { create } from 'zustand';
import type {
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { emptyPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';

/**
 * Renderer mirror of `PreferencesData.globalPluginSelections` — the global
 * default-plugin overlay. Display-only: pickers use it to show the effective
 * selection set and to split saves into local selections + tombstones. The
 * main process owns resolution; this store never persists anything.
 */
interface GlobalPluginDefaultsState {
  selections: ChatTabPluginSelections;
  hydrated: boolean;
  /** In-store so a failed initial load can be retried by a later call. */
  loadInFlight: boolean;
  /** Idempotent while a load is pending or done; retries after a failure. */
  hydrate: (preferences?: PreferencesData) => Promise<boolean>;
}

let preferencesSyncSubscribed = false;
let hydrationPromise: Promise<boolean> | null = null;

/**
 * The selections to hold for `preferences`. Selections equal to the held ones
 * keep their object: every preferences broadcast (one per navigation) carries
 * a new copy, and each new one rendered every open composer again.
 */
function heldSelections(
  current: GlobalPluginDefaultsState,
  preferences: PreferencesData,
): ChatTabPluginSelections {
  const selections =
    preferences.globalPluginSelections ?? emptyPluginSelections();
  return current.hydrated &&
    JSON.stringify(current.selections) === JSON.stringify(selections)
    ? current.selections
    : selections;
}

export const useGlobalPluginDefaultsStore = create<GlobalPluginDefaultsState>(
  (set, get) => ({
    selections: emptyPluginSelections(),
    hydrated: false,
    loadInFlight: false,
    hydrate: (preferences?: PreferencesData): Promise<boolean> => {
      // Guarded lookups keep app-shell tests with partial window.api mocks
      // rendering; production always exposes both methods.
      if (
        !preferencesSyncSubscribed &&
        typeof window.api?.onPreferencesSynced === 'function'
      ) {
        preferencesSyncSubscribed = true;
        // App-lifetime subscription; the unsubscribe handle is intentionally
        // dropped because this store lives for the whole renderer session.
        window.api.onPreferencesSynced((preferences) => {
          set({
            selections: heldSelections(get(), preferences),
            hydrated: true,
          });
        });
      }
      if (preferences) {
        set({
          selections: heldSelections(get(), preferences),
          hydrated: true,
        });
        return Promise.resolve(true);
      }
      if (get().hydrated) return Promise.resolve(true);
      if (hydrationPromise) return hydrationPromise;
      if (typeof window.api?.loadPreferences !== 'function') {
        return Promise.resolve(false);
      }
      set({ loadInFlight: true });
      hydrationPromise = window.api
        .loadPreferences()
        .then((preferences) => {
          set({
            selections: heldSelections(get(), preferences),
            hydrated: true,
          });
          return true;
        })
        .catch(() => {
          // Leave `hydrated` false so a later hydrate() (e.g. opening the
          // plugins modal) retries instead of silently serving an empty
          // overlay forever.
          return false;
        })
        .finally(() => {
          hydrationPromise = null;
          set({ loadInFlight: false });
        });
      return hydrationPromise;
    },
  }),
);
