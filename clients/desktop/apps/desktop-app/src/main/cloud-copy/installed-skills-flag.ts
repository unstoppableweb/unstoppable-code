import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/**
 * Whether skills installed from GitHub, a URL or a local folder may go to the
 * cloud account (CAN-6943). Main is the only enforcement point: off, their
 * analysis answers `unsupported` and a publish is refused.
 */
export function installedSkillCloudCopyEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills.key,
  );
}
