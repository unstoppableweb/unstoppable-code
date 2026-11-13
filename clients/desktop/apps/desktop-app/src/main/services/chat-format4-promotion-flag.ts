import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/**
 * Whether writable chat scopes may promote to storage format 4
 * (`canopy-desktop-chat-format4-promotion`, CAN-6192). Off by default, and
 * off while flags are unavailable. Turning it off stops new promotions; a
 * scope already in format 4 stays in format 4.
 */
export function isChatFormat4PromotionEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion.key,
  );
}
