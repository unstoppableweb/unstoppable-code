import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Returns whether the `canopy-desktop-shared-automations-workflow-form` flag
 * is on (CAN-6455): desktop shares as workflows the chat automations it
 * would otherwise share in chat form. Main checks the same flag.
 */
export function useSharedAutomationsWorkflowFormEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm.key,
    ),
  );
}
