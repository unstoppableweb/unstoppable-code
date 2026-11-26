import {
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

/**
 * Whether the `canopy-remote-web-preview` flag allows web preview now
 * (CAN-7705). It fails closed: only a `ready` snapshot counts. One the service publishes as
 * `initializing` or `error` may carry earlier values, but counts as off.
 * During a context refresh, such as an account switch, the last `ready`
 * value applies until the service publishes a new status; the security
 * review records that as an accepted risk.
 */
export function webPreviewFlagOn(
  snapshot: Pick<FeatureFlagSnapshot, 'status' | 'values'>,
): boolean {
  return (
    snapshot.status === 'ready' &&
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyRemoteWebPreview.key] === true
  );
}
