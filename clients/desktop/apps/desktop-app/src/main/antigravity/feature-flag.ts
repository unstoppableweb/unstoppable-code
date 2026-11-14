import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

export function isAntigravityHarnessEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key,
  );
}

export function assertAntigravityHarnessEnabled(): void {
  if (!isAntigravityHarnessEnabled())
    throw new Error('Antigravity is unavailable. Choose another provider.');
}
