import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { isAgentDaemonHostingRequired } from '@canopy/core-runtime/node/agent/hosting';
import { getFeatureFlagService } from '../feature-flags';

/**
 * Whether writable chat scopes may promote to storage format 4
 * (`canopy-desktop-chat-format4-promotion`, CAN-6192). Off by default, and
 * off while flags are unavailable. Turning it off stops new promotions; a
 * scope already in format 4 stays in format 4. A build whose compiled rows
 * hand chat storage to the daemon promotes whatever the switch says, since
 * the daemon never writes format 3 (CAN-7178).
 */
export function isChatFormat4PromotionEnabled(
  daemonHostsChats: () => boolean = isAgentDaemonHostingRequired,
): boolean {
  return (
    daemonHostsChats() ||
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion.key,
    )
  );
}
