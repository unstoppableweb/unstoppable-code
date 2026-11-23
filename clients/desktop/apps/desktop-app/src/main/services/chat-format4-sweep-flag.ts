import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/**
 * Whether the background sweep may promote the chat scopes nobody opens
 * (`canopy-desktop-chat-format4-sweep`, CAN-7178). Off by default, and off
 * while flags are unavailable. The sweep also needs
 * `canopy-desktop-chat-format4-promotion`; turning this off stops the sweep
 * before its next scope, and a scope already in format 4 stays in format 4.
 */
export function isChatFormat4SweepEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Sweep.key,
  );
}
