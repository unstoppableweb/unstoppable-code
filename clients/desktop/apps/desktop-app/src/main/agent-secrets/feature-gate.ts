import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/**
 * The live `canopy-shared-agent-secret-requests` gate. Checked where the
 * tools are offered, when a call runs and when a person submits, so turning
 * the flag off takes effect for a running session too.
 */
export function isAgentSecretRequestsEnabled(): boolean {
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key,
    );
  } catch {
    return false;
  }
}
