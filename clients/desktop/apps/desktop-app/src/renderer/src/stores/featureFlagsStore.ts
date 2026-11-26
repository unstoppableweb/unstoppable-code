import { create } from 'zustand';
import {
  getClientFeatureFlagDefaultValue,
  getDefaultFeatureFlagSnapshot,
  getLocalOnlyClientFeatureFlagDefaults,
  isCoreFeatureFlagKey,
  type ClientFeatureFlagKey,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { addClientFeatureFlagEvaluation } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  followCoreFeatureFlags,
  type CoreFeatureFlags,
} from '../client/core-feature-flag-client';
import { isLocalOnlyBuild } from '../lib/local-only-build';
import { reportRendererConsoleError } from '../lib/renderer-error-logging';
import { readRemoteControlContext } from './remoteControlStore';

/**
 * The snapshot the store holds until main's arrives. A local-only build
 * (docs/local-only-build.md) starts from the same local-only defaults main's
 * FeatureFlagService serves, so hosted flags are never on before hydrate or
 * after a failed one.
 */
function initialFeatureFlagSnapshot(): FeatureFlagSnapshot {
  const snapshot = getDefaultFeatureFlagSnapshot();
  return isLocalOnlyBuild()
    ? { ...snapshot, values: getLocalOnlyClientFeatureFlagDefaults() }
    : snapshot;
}

function reportSnapshotToInstrumentation(snapshot: FeatureFlagSnapshot): void {
  for (const [key, value] of Object.entries(snapshot.values)) {
    if (
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string' ||
      value === null
    ) {
      addClientFeatureFlagEvaluation(key, value);
    }
  }
}

/**
 * Core's value wins for the flags core owns or shares; interface flags stay
 * the IPC snapshot's. A value of another type than the registry's is dropped.
 */
function withCoreFlags(
  ipc: FeatureFlagSnapshot,
  core: CoreFeatureFlags | null,
): FeatureFlagSnapshot {
  if (core === null) return ipc;
  const flags = Object.fromEntries(
    Object.entries(core.flags).filter(
      ([key, value]) =>
        isCoreFeatureFlagKey(key) && typeof value === typeof ipc.values[key],
    ),
  );
  return {
    ...ipc,
    ...core.provenance,
    values: Object.assign({}, ipc.values, flags),
  };
}

/**
 * Renderer-side cache of the latest `FeatureFlagSnapshot`.
 *
 * Electron main's feature-flag service is the source of truth. Every flag
 * arrives through `window.api.featureFlags.getSnapshot()` and
 * `onSnapshotChanged()`; the main window's `follow()` also reads the flags
 * core owns or shares through `core.featureFlag.*` on the renderer relay
 * (CAN-4181 F5), which win over the IPC copy only while they are fresh: after
 * any relay or stream failure, and from each IPC snapshot on, every flag and
 * the status read IPC until core reads again.
 * Interface-only flags never cross core, and a Remote Control window and App
 * Advisor stay on the IPC copy alone.
 *
 * Renderer reads are UX state only: real gating happens server-side. If
 * LaunchDarkly is unconfigured or `hydrate()` fails, the store starts from
 * `getDefaultFeatureFlagSnapshot()` (the protocol defaults for the
 * LaunchDarkly-disabled mode). Snapshots produced while LaunchDarkly is
 * configured but unavailable should come from the main-process evaluator and
 * carry that mode's fallback values.
 */
interface FeatureFlagsStoreState {
  /** Every flag as the renderer reads it: the IPC snapshot with core's values. */
  snapshot: FeatureFlagSnapshot;
  /** The latest snapshot delivered over IPC (defaults until hydrate). */
  ipcSnapshot: FeatureFlagSnapshot;
  /**
   * Core's values while fresh (read since the last failure or IPC snapshot);
   * `null` otherwise.
   */
  core: CoreFeatureFlags | null;
  /**
   * Fetches the current snapshot from the main process and stores it. The
   * promise never rejects: any failure is swallowed and the previous (or
   * default) snapshot remains in place so the renderer can keep rendering.
   */
  hydrate: () => Promise<void>;
  /**
   * Replaces the IPC snapshot with a freshly broadcast envelope and drops
   * core's values.
   */
  setSnapshot: (snapshot: FeatureFlagSnapshot) => void;
  /** Replaces core's values; `null` discards them. */
  setCoreFlags: (core: CoreFeatureFlags | null) => void;
  /**
   * Hydrates, applies every IPC broadcast, retries LaunchDarkly on `online`
   * and, in a window showing this computer, follows core's flags. Returns the
   * stop, which drops core's values.
   */
  follow: () => () => void;
  /**
   * Returns `true` when the named client-visible flag is currently on.
   * Falls back according to the active snapshot status when the snapshot has
   * not populated the key.
   */
  isEnabled: (key: ClientFeatureFlagKey) => boolean;
}

export const useFeatureFlagsStore = create<FeatureFlagsStoreState>(
  (set, get) => {
    const publish = (
      ipcSnapshot: FeatureFlagSnapshot,
      core: CoreFeatureFlags | null,
    ): void => {
      const snapshot = withCoreFlags(ipcSnapshot, core);
      reportSnapshotToInstrumentation(snapshot);
      set({ snapshot, ipcSnapshot, core });
    };
    const initial = initialFeatureFlagSnapshot();
    // IPC snapshots published so far; the core follower drops a snapshot read
    // or stream item that one overtook.
    let ipcSnapshots = 0;
    return {
      snapshot: initial,
      ipcSnapshot: initial,
      core: null,
      hydrate: async (): Promise<void> => {
        try {
          const snapshot = await window.api.featureFlags.getSnapshot();
          get().setSnapshot(snapshot);
        } catch (error) {
          reportRendererConsoleError('Failed to hydrate feature flags', {
            error,
          });
          // Never block render. The default snapshot is kept in place so
          // consumers continue to see baseline (enabled) values.
        }
      },
      setSnapshot: (snapshot): void => {
        ipcSnapshots++;
        // It may be another account's: core's values wait for core's re-read.
        publish(snapshot, null);
      },
      setCoreFlags: (core): void => publish(get().ipcSnapshot, core),
      follow: (): (() => void) => {
        void get().hydrate();
        const unsubscribe = window.api.featureFlags.onSnapshotChanged(
          (snapshot) => get().setSnapshot(snapshot),
        );
        // Remote Control blocks the relay; that window reads the other
        // computer's flags over the tunneled channels alone.
        const stopCore =
          readRemoteControlContext().mode === 'local' && window.canopyCore
            ? followCoreFeatureFlags(
                window.canopyCore,
                get().setCoreFlags,
                () => ipcSnapshots,
              )
            : null;
        // Electron main has no network-change event, so the renderer's
        // `online` tells main to retry a failed LaunchDarkly start right away
        // instead of waiting out its backoff (CAN-3511). Healthy snapshots
        // skip the call. IPC's own status decides: core may be fresh but not
        // yet streamed the host's error.
        const retryUnavailableFlags = (): void => {
          if (get().ipcSnapshot.status !== 'error') return;
          // A failed retry leaves main's own backoff in charge; classified only.
          void window.api.featureFlags
            .refreshContext()
            .catch((error: unknown) => {
              toAppError(error);
            });
        };
        window.addEventListener('online', retryUnavailableFlags);
        return (): void => {
          unsubscribe();
          window.removeEventListener('online', retryUnavailableFlags);
          if (stopCore === null) return;
          stopCore();
          get().setCoreFlags(null);
        };
      },
      isEnabled: (key): boolean => {
        const value = get().snapshot.values[key];
        if (typeof value === 'boolean') {
          return value;
        }
        const fallback = getClientFeatureFlagDefaultValue(
          key,
          get().snapshot.status === 'not_configured'
            ? 'launchdarkly_disabled'
            : 'launchdarkly_enabled_unavailable',
        );
        return typeof fallback === 'boolean' ? fallback : false;
      },
    };
  },
);
