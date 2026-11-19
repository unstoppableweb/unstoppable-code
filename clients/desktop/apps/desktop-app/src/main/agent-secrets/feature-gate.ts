import { hostPlatformOperatingSystem } from '@canopy/core-platform';
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

/**
 * Whether RunWithSecrets can run here. It must end everything a command
 * started, so no process keeps the secrets after the call. POSIX gives the
 * command its own process group; Windows needs the command in a job object
 * the call owns (the owned-child backend), which it doesn't use yet, and
 * `taskkill` from an exited shell misses its descendants. Until then the
 * tool is not offered on Windows.
 */
export function isRunWithSecretsSupported(): boolean {
  return hostPlatformOperatingSystem() !== 'win32';
}
