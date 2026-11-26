import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  formatPageUnavailableMessage,
  getPageAvailability,
} from '@/lib/navigation/page-availability';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Open one local agent's editor over its Marketplace detail (CAN-4266).
 * Throws when agents are switched off or the Marketplace is unavailable.
 */
export function requestAgentEditor(agentId: string): void {
  if (
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key)
  ) {
    throw new Error('Model presets are not available.');
  }
  const availability = getPageAvailability('plugins');
  if (!availability.available) {
    throw new Error(formatPageUnavailableMessage(availability));
  }
  useNavigationStore.getState().openAgentReveal({ agentId, mode: 'edit' });
}
