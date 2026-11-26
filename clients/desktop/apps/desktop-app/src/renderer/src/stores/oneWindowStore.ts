import { useEffect } from 'react';
import { create } from 'zustand';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  CanopyApi,
  PairedComputersApi,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';
import { readRemoteControlContext } from './remoteControlStore';

/**
 * The window's read of the one-window switch (CAN-7755), Settings → Labs →
 * One window for all computers. Main owns the switch
 * (`main/lib/one-window-switch.ts`); this store mirrors main's current
 * value, which every `preferences:load` reply carries as
 * `__oneWindowEnabled`. It never resolves the saved choice itself, so it
 * can't show a value main hasn't applied: a save whose commit didn't
 * complete, or a reply that arrives after a recovery latched.
 *
 * The store starts following on its first read. Preference broadcasts and
 * this window's saves only start a fresh read, since they can arrive out of
 * order, and only the latest read applies. Until a read answers the store
 * reads off and not yet loaded. A failed read, or one main marks
 * `__preferencesUnconfirmed` (defaults or a last-good copy after a failed
 * recovery), leaves it not loaded and off, and the next read of the store
 * with no read in flight tries again. A window that shows another computer
 * always reads off and never asks: the switch belongs to the computer in
 * front of the person, and that window's preferences are the other
 * computer's.
 */
interface OneWindowState {
  readonly enabled: boolean;
  readonly loaded: boolean;
}

const useOneWindowStore = create<OneWindowState>(() => ({
  enabled: false,
  loaded: false,
}));

let following = false;
let latestRead = 0;
let readsInFlight = 0;

function showsThisComputer(): boolean {
  return readRemoteControlContext().mode === 'local';
}

function applyRead(
  preferences: Pick<
    PreferencesLoadResult,
    '__oneWindowEnabled' | '__preferencesUnconfirmed'
  >,
): void {
  if (preferences.__preferencesUnconfirmed === true) {
    // Not the person's choice: forget any earlier one, so the switch reads
    // off and Settings disables it until a read is confirmed.
    useOneWindowStore.setState({ enabled: false, loaded: false });
    return;
  }
  useOneWindowStore.setState({
    enabled: preferences.__oneWindowEnabled === true,
    loaded: true,
  });
}

function readSwitch(): Promise<void> {
  const read = ++latestRead;
  readsInFlight += 1;
  return window.api
    .loadPreferences()
    .then((preferences) => {
      if (read === latestRead) applyRead(preferences);
    })
    .catch((cause: unknown) => {
      reportClientAppError(cause);
      // Main's value is unknown now: forget the last one, so the switch
      // reads off and Settings disables it until a read answers. A failure
      // of a read that a newer one replaced changes nothing.
      if (read === latestRead)
        useOneWindowStore.setState({ enabled: false, loaded: false });
    })
    .finally(() => {
      readsInFlight -= 1;
    });
}

function followReads(): void {
  void readSwitch();
}

function followOneWindowSwitch(): void {
  if (!following) {
    following = true;
    if (!showsThisComputer()) {
      useOneWindowStore.setState({ loaded: true });
      return;
    }
    window.api.onPreferencesSynced(followReads);
    // Main sends this when preferences change without a save, such as a
    // failed recovery latching.
    window.api.onPreferencesChanged(followReads);
    subscribePreferencesUpdated(followReads);
  }
  // The first read, or a retry after every read so far failed.
  if (
    showsThisComputer() &&
    !useOneWindowStore.getState().loaded &&
    readsInFlight === 0
  )
    followReads();
}

/**
 * Reads main's switch again, after a save of it; resolves once that read
 * settles. The save's reply is never applied directly: main's value after
 * the commit is what counts.
 */
export function refreshOneWindowSwitch(): Promise<void> {
  if (!showsThisComputer()) return Promise.resolve();
  return readSwitch();
}

/** Whether the one-window work is on, for code outside React. */
export function isOneWindowEnabled(): boolean {
  followOneWindowSwitch();
  return useOneWindowStore.getState().enabled;
}

/**
 * Whether the one-window work is on, and whether the saved choice has been
 * read yet; re-renders when either changes.
 */
export function useOneWindowSwitch(): OneWindowState {
  useEffect(followOneWindowSwitch, []);
  const enabled = useOneWindowStore((state) => state.enabled);
  const loaded = useOneWindowStore((state) => state.loaded);
  return { enabled, loaded };
}

/** Whether the one-window work is on; re-renders when it changes. */
export function useOneWindowEnabled(): boolean {
  return useOneWindowSwitch().enabled;
}

function pairedComputersApi(enabled: boolean): PairedComputersApi | null {
  if (!enabled) return null;
  const api: Partial<Pick<CanopyApi, 'pairedComputers'>> | undefined =
    typeof window === 'undefined' ? undefined : window.api;
  return api?.pairedComputers ?? null;
}

/**
 * The main window's API for a named paired computer (CAN-7761), or null
 * while the switch is off, in a window that shows another computer (which
 * always reads off), or where it is not installed. Main refuses every call
 * while its own read of the switch is off, whatever the window believes.
 */
export function getPairedComputersApi(): PairedComputersApi | null {
  return pairedComputersApi(isOneWindowEnabled());
}

/** `getPairedComputersApi`, re-rendering when the switch changes. */
export function usePairedComputersApi(): PairedComputersApi | null {
  return pairedComputersApi(useOneWindowEnabled());
}
