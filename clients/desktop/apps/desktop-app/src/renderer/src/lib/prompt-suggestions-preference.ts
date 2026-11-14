import { useSyncExternalStore } from 'react';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { subscribePreferencesUpdated } from './preferences-events';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

let enabled = true;
let started = false;
let revision = 0;
const listeners = new Set<() => void>();

function applyPreferences(preferences: PreferencesData): void {
  revision += 1;
  // Absent means a file from before the setting existed: keep the default.
  const next = preferences.promptSuggestionsEnabled !== false;
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  window.api.onPreferencesSynced(applyPreferences);
  subscribePreferencesUpdated(applyPreferences);
  const before = revision;
  void window.api
    .loadPreferences()
    .then((preferences) => {
      // A broadcast that arrived first is newer than this read.
      if (revision === before) applyPreferences(preferences);
    })
    .catch((error: unknown) => {
      // Keep the default (on) until a preference broadcast arrives.
      reportClientAppError(error);
    });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Settings → Models → Next prompt suggestions, on by default. Follows saves
 * from this and other windows.
 */
export function usePromptSuggestionsEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled);
}
