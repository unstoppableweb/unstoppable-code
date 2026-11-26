import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isSlackConversationsChat } from '../remote-control/host/hosted-orchestrator-desktop';
import { SLACK_TURN_GUIDANCE } from './system-prompt';

export interface SlackTurnGuidanceDeps {
  flagEnabled(): boolean;
  isSlackChat(worktreeId: string, chatId: string): Promise<boolean>;
}

const DEFAULT_DEPS: SlackTurnGuidanceDeps = {
  // A synchronous in-memory read. The person's Slack requests preference is
  // deliberately not checked: a turn queued just before they turn it off
  // still gets the guidance.
  flagEnabled: () =>
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopSlackOrchestratorRequests.key,
    ),
  isSlackChat: isSlackConversationsChat,
};

/**
 * The Slack-turn guidance for an Orchestrator turn in a Slack tab (CAN-7608),
 * or null. The tab check runs only with the flag on. Fail-open: a read
 * failure logs a warning and leaves the guidance out, never failing the turn.
 */
export async function slackTurnGuidanceFor(
  worktreeId: string,
  chatId: string,
  deps: SlackTurnGuidanceDeps = DEFAULT_DEPS,
): Promise<string | null> {
  try {
    if (!deps.flagEnabled()) return null;
    return (await deps.isSlackChat(worktreeId, chatId))
      ? SLACK_TURN_GUIDANCE
      : null;
  } catch (error) {
    logMainProcessWarn('Slack turn guidance check failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}
