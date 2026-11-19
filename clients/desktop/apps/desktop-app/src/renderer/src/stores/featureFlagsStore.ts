import { create } from 'zustand';
import {
  getClientFeatureFlagDefaultValue,
  getDefaultFeatureFlagSnapshot,
  getLocalOnlyClientFeatureFlagDefaults,
  type ClientFeatureFlagKey,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { addClientFeatureFlagEvaluation } from '@canopy/desktop-instrumentation/client';
import { isLocalOnlyBuild } from '../lib/local-only-build';
import { reportRendererConsoleError } from '../lib/renderer-error-logging';

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
 * Renderer-side cache of the latest `FeatureFlagSnapshot` delivered by the
 * main-process feature-flag service.
 *
 * The main process is the source of truth for flag values — the renderer
 * receives copies via `window.api.featureFlags.getSnapshot()` (initial
 * fetch) and `window.api.featureFlags.onSnapshotChanged()` (push updates).
 *
 * Renderer reads are UX state only: real gating happens server-side. If
 * If LaunchDarkly is unconfigured or `hydrate()` fails, the store starts from
 * `getDefaultFeatureFlagSnapshot()` (the protocol defaults for the
 * LaunchDarkly-disabled mode). Snapshots produced while LaunchDarkly is
 * configured but unavailable should come from the main-process evaluator and
 * carry that mode's fallback values.
 */
interface FeatureFlagsStoreState {
  /** Latest snapshot delivered by the main process (defaults until hydrate). */
  snapshot: FeatureFlagSnapshot;
  /**
   * Fetches the current snapshot from the main process and stores it. The
   * promise never rejects: any failure is swallowed and the previous (or
   * default) snapshot remains in place so the renderer can keep rendering.
   */
  hydrate: () => Promise<void>;
  /** Replaces the in-store snapshot with a freshly broadcast envelope. */
  setSnapshot: (snapshot: FeatureFlagSnapshot) => void;
  /**
   * Returns `true` when the named client-visible flag is currently on.
   * Falls back according to the active snapshot status when the snapshot has
   * not populated the key.
   */
  isEnabled: (key: ClientFeatureFlagKey) => boolean;
}

export const useFeatureFlagsStore = create<FeatureFlagsStoreState>(
  (set, get) => ({
    snapshot: initialFeatureFlagSnapshot(),
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
      reportSnapshotToInstrumentation(snapshot);
      set({ snapshot });
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
  }),
);
