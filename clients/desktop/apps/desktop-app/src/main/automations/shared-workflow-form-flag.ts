import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/**
 * Whether desktop shares, as workflows, the chat automations it would
 * otherwise share in chat form (`canopy-desktop-shared-automations-workflow-form`,
 * CAN-6455). Off by default, and off while flags are unavailable: recipients
 * on a desktop without CAN-6548 would get a free-text project box.
 */
export function isSharedAutomationsWorkflowFormEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm.key,
  );
}
