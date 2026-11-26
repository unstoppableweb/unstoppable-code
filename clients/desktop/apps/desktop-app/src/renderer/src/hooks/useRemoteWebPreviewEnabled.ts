import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Returns whether the `canopy-remote-web-preview` flag is on (CAN-7705):
 * paired computers may open this computer's local web servers. Like main,
 * which checks the same flag before it offers or dials anything, only a
 * `ready` snapshot counts: one the flag service publishes as `initializing`
 * or `error` may keep an earlier value but counts as off.
 */
export function useRemoteWebPreviewEnabled(): boolean {
  return useFeatureFlagsStore(
    (s) =>
      s.snapshot.status === 'ready' &&
      s.snapshot.values[CLIENT_FEATURE_FLAGS.canopyRemoteWebPreview.key] ===
        true,
  );
}
