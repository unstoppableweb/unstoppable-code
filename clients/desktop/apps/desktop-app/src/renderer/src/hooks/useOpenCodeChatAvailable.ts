import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useEffect, useState } from 'react';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';

/**
 * The last answer any mount read. A picker mounted later starts from it, so a
 * connected user does not see "Connect OpenCode" while the new read is pending.
 */
let lastKnownAvailable: boolean | undefined;

/**
 * Tri-state availability (installed and on): `undefined` until the first
 * status read settles, so billing readiness never treats a pending read as
 * "not set up". The harness flag being off settles `false` straight away.
 */
export function useOpenCodeChatAvailability(
  enabled: boolean,
): boolean | undefined {
  const opencodeHarnessEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  const [available, setAvailable] = useState<boolean | undefined>(
    lastKnownAvailable,
  );
  useEffect(() => {
    if (!enabled || !opencodeHarnessEnabled) return;
    let mounted = true;
    let revision = 0;
    const refresh = (): void => {
      const current = ++revision;
      // Read the preference first: most users never enable OpenCode, and the
      // runtime status probe touches the filesystem on the main thread.
      void window.api
        .loadPreferences()
        .then((preferences) =>
          preferences.opencodeEnabled
            ? window.api.opencodeConnection?.status()
            : undefined,
        )
        .then((managed) => {
          const next = Boolean(
            managed?.supported && managed.enabled && managed.installed,
          );
          if (current !== revision) return;
          lastKnownAvailable = next;
          if (mounted) setAvailable(next);
        })
        .catch(() => {
          if (current !== revision) return;
          lastKnownAvailable = false;
          if (mounted) setAvailable(false);
        });
    };
    refresh();
    const offLocal = subscribePreferencesUpdated(refresh);
    const offHost = window.api.onPreferencesChanged(refresh);
    return (): void => {
      mounted = false;
      offLocal();
      offHost();
    };
  }, [enabled, opencodeHarnessEnabled]);
  if (!enabled || !opencodeHarnessEnabled) return false;
  return available;
}

export function useOpenCodeChatAvailable(enabled: boolean): boolean {
  return useOpenCodeChatAvailability(enabled) === true;
}
