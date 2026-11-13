// Renderer mirror of launch at sign-in (CAN-3449). The main process owns the
// OS registration and there is no saved preference: this store reads
// `window.api.launchAtLogin.getStatus()`, follows the
// `launch-at-login:status-changed` pushes, and re-reads whenever the window
// regains focus, because the user can change it in System Settings or Task
// Manager while the app is in the background. Settings, the Getting started
// checklist, and App Advisor all read this one snapshot.

import { useEffect } from 'react';
import { create } from 'zustand';
import { launchAtLoginSatisfies } from '@canopy/desktop-shared/lib/launch-at-login';
import type {
  LaunchAtLoginApi,
  LaunchAtLoginSetResult,
  LaunchAtLoginStatus,
} from '@canopy/desktop-shared/types';

/**
 * Why the last change did not stick. `refused`: the OS kept a different
 * state. `failed`: the request never got an answer. `requested` is the value
 * the user asked for, so the message can say "on" or "off".
 */
export interface LaunchAtLoginError {
  reason: 'refused' | 'failed';
  requested: boolean;
}

export interface LaunchAtLoginStore {
  status: LaunchAtLoginStatus | null;
  hydrated: boolean;
  /** True while a change round trip is in flight. */
  busy: boolean;
  error: LaunchAtLoginError | null;
  /** Attach the status-push subscription; returns the detach function. */
  subscribeBridge: () => () => void;
  /** Re-read the OS status. */
  refresh: () => Promise<void>;
  /**
   * Ask the OS for a change. Resolves with main's answer (`null` without a
   * bridge); rethrows a failed round trip after recording it.
   */
  setEnabled: (enabled: boolean) => Promise<LaunchAtLoginSetResult | null>;
  openSystemSettings: () => Promise<void>;
  /**
   * Read now, follow pushes, and re-read on window focus until the returned
   * function detaches it. Every watcher shares one push subscription, one
   * focus listener, and one in-flight read.
   */
  watch: () => () => void;
}

function getApi(): LaunchAtLoginApi | undefined {
  return typeof window !== 'undefined' ? window.api?.launchAtLogin : undefined;
}

function sameStatus(
  left: LaunchAtLoginStatus,
  right: LaunchAtLoginStatus,
): boolean {
  return (
    left.platform === right.platform &&
    left.supported === right.supported &&
    left.unsupportedReason === right.unsupportedReason &&
    left.enabled === right.enabled &&
    left.pendingApproval === right.pendingApproval
  );
}

export const useLaunchAtLoginStore = create<LaunchAtLoginStore>((set, get) => {
  // Pushes received so far. A read or set response must not overwrite a push
  // that landed while it was in flight with the older snapshot it captured.
  let pushCount = 0;
  // Reads started so far, and the newest one whose answer was applied.
  // Detaching the last watcher abandons a read without cancelling it, so a
  // slow older read must not overwrite the answer of a newer one.
  let readsStarted = 0;
  let newestReadApplied = 0;
  // Settings, the checklist, and App Advisor can all be mounted at once; they
  // share one subscription and one focus listener, and a read already in
  // flight answers every caller that asks while it runs.
  let watchers = 0;
  let detachShared: (() => void) | null = null;
  let readInFlight: Promise<void> | null = null;
  const applyStatus = (status: LaunchAtLoginStatus): void => {
    const current = get();
    // Keep the existing object when nothing changed so a focus re-read does
    // not re-render every consumer.
    const next =
      current.status !== null && sameStatus(current.status, status)
        ? current.status
        : status;
    const clearError =
      current.error !== null &&
      launchAtLoginSatisfies(next, current.error.requested);
    if (next === current.status && current.hydrated && !clearError) return;
    set({
      status: next,
      hydrated: true,
      ...(clearError ? { error: null } : {}),
    });
  };
  const subscribeBridge = (): (() => void) => {
    const api = getApi();
    if (!api?.onStatusChanged) return (): void => undefined;
    return api.onStatusChanged((status) => {
      pushCount += 1;
      applyStatus(status);
    });
  };
  const readStatus = async (): Promise<void> => {
    const api = getApi();
    if (!api?.getStatus) {
      // Mounted without the preload bridge (unit tests): stop waiting.
      set({ hydrated: true });
      return;
    }
    const pushesBefore = pushCount;
    readsStarted += 1;
    const read = readsStarted;
    try {
      const status = await api.getStatus();
      if (pushCount === pushesBefore && read > newestReadApplied) {
        newestReadApplied = read;
        applyStatus(status);
      } else {
        set({ hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  };
  const refresh = (): Promise<void> => {
    if (readInFlight !== null) return readInFlight;
    const read = readStatus().finally(() => {
      if (readInFlight === read) readInFlight = null;
    });
    readInFlight = read;
    return read;
  };
  return {
    status: null,
    hydrated: false,
    busy: false,
    error: null,
    subscribeBridge,
    refresh,
    setEnabled: async (enabled): Promise<LaunchAtLoginSetResult | null> => {
      const api = getApi();
      if (!api?.setEnabled) return null;
      set({ busy: true, error: null });
      const pushesBefore = pushCount;
      try {
        const result = await api.setEnabled(enabled);
        if (pushCount === pushesBefore) applyStatus(result.status);
        if (!result.ok && result.reason === 'refused') {
          set({ error: { reason: 'refused', requested: enabled } });
        }
        return result;
      } catch (error) {
        set({ error: { reason: 'failed', requested: enabled } });
        throw error;
      } finally {
        set({ busy: false });
      }
    },
    openSystemSettings: async (): Promise<void> => {
      await getApi()?.openSystemSettings();
    },
    watch: (): (() => void) => {
      watchers += 1;
      if (watchers === 1) {
        const unsubscribe = subscribeBridge();
        const target = typeof window !== 'undefined' ? window : null;
        const onFocus = (): void => {
          void refresh();
        };
        target?.addEventListener('focus', onFocus);
        detachShared = (): void => {
          target?.removeEventListener('focus', onFocus);
          unsubscribe();
        };
      }
      void refresh();
      let detached = false;
      return (): void => {
        if (detached) return;
        detached = true;
        watchers -= 1;
        if (watchers === 0) {
          detachShared?.();
          detachShared = null;
          // A read that never answered must not block the next consumer.
          readInFlight = null;
        }
      };
    },
  };
});

/** Reads on mount, follows pushes and window focus for the caller's lifetime. */
export function useLaunchAtLoginStatus(): {
  status: LaunchAtLoginStatus | null;
  hydrated: boolean;
  busy: boolean;
  error: LaunchAtLoginError | null;
} {
  const status = useLaunchAtLoginStore((state) => state.status);
  const hydrated = useLaunchAtLoginStore((state) => state.hydrated);
  const busy = useLaunchAtLoginStore((state) => state.busy);
  const error = useLaunchAtLoginStore((state) => state.error);
  useEffect(() => useLaunchAtLoginStore.getState().watch(), []);
  return { status, hydrated, busy, error };
}
