import type {
  SlackLinkAttentionReason,
  SlackLinkStatus,
} from '@canopy/protocol/settings/account-slack-link';
import type {
  SlackConnectThisComputerRefusal,
  SlackLinkStartRefusal,
} from './slack-settings-host';

// Copy for Account → Integrations → Slack (CAN-7606). Every message about a
// failure is fixed local copy keyed by a typed reason, never response text.

/** The Slack app's handle, as people type it in Slack (CAN-7607 owns it). */
export const SLACK_MENTION = '@unstoppable';

export const SLACK_CARD_TITLE = 'Slack';

export const SLACK_UNAVAILABLE_TEXT =
  "Slack isn't available for this account yet.";

/**
 * Under {@link SLACK_UNAVAILABLE_TEXT} when a Slack link (the bot's setup
 * message) led here: what to do instead, beside Start a task.
 */
export const SLACK_NOT_OFFERED_NEXT_STEP_TEXT =
  'You can still give your agents work by starting a task here.';

export function slackCardSubtitle(): string {
  return `Link your Slack account so your mentions of ${SLACK_MENTION} start work on your computer.`;
}

/** {@link slackConsentText} for the computer the page runs on. */
export const SLACK_CONSENT_THIS_COMPUTER = 'this computer';
/** {@link slackConsentText} while no computer is picked yet. */
export const SLACK_CONSENT_UNPICKED = 'the computer you choose';

/**
 * The consent line beside Connect Slack. `where` is a computer's name,
 * {@link SLACK_CONSENT_THIS_COMPUTER} or {@link SLACK_CONSENT_UNPICKED}.
 */
export function slackConsentText(where: string): string {
  return `When you mention ${SLACK_MENTION} in Slack, your agents on ${where} can start work. Only your own posts reach it.`;
}

/**
 * Under the consent line beside Connect Slack (CAN-7689): for a workspace
 * that doesn't have the app yet, before any connect attempt fails.
 */
export function slackNewWorkspaceText(appName: string): string {
  return `Is your workspace new to ${appName}?`;
}

/** The link after {@link slackNewWorkspaceText}; it opens `/slack`. */
export const SLACK_ADD_FIRST_LINK_LABEL = 'Add it to Slack first.';

export const SLACK_STATUS_LABELS: Readonly<Record<SlackLinkStatus, string>> = {
  active: 'Active',
  paused: 'Paused',
  needs_attention: 'Needs attention',
};

/** The header dot's label when a link works. */
export const SLACK_CONNECTED_LABEL = 'Connected';
/** The header dot's label with no link. */
export const SLACK_NOT_CONNECTED_LABEL = 'Not connected';

/** The header dot's label when a link's computer is offline. */
export const SLACK_COMPUTER_OFFLINE_LABEL = 'Computer offline';

/**
 * Read to assistive technology when a new link lands. Sighted people see the
 * header's dot turn green and the new row instead.
 */
export const SLACK_CONNECTED_ANNOUNCEMENT = 'Slack is connected.';

/**
 * An active link whose computer is offline, so mentions can't reach it. With
 * no other computer to change to, it names the way there: on another
 * computer, the app offers Use this computer.
 */
export function slackOfflineLinkText(
  computerName: string,
  appName: string,
  canChange: boolean,
): string {
  const fix = canChange
    ? 'or change computer'
    : 'or on another computer to move Slack there';
  return `${computerName} is offline, so your mentions can't start work. Open ${appName} on it, ${fix}.`;
}

/**
 * An unpaired link's attention text where another computer can take it:
 * the row then offers Change computer in place of Connect again.
 */
export const SLACK_UNPAIRED_CHANGE_TEXT =
  'Its computer is no longer paired for agents. Change computer to keep using Slack.';

/** Opens Connect for a workspace beside the section's existing links. */
export const SLACK_CONNECT_ANOTHER_LABEL = 'Connect another Slack workspace';

/** Opens the picker that moves a link to another computer. */
export const SLACK_CHANGE_COMPUTER_LABEL = 'Change computer';
/** Desktop: moves a link whose computer is offline to this one. */
export const SLACK_USE_THIS_COMPUTER_LABEL = 'Use this computer';

/** Change computer didn't move the link. */
export function slackMoveRefusalText(
  reason: 'computer_not_paired' | 'failed',
): string {
  return reason === 'computer_not_paired'
    ? 'That computer is no longer paired for agents. Pick another or pair it again.'
    : "Couldn't change computer. Try again.";
}

/**
 * Change computer moved a link to another of the person's computers. That
 * computer answers mentions only while it listens for Slack, which only it
 * can turn on: its own row then offers Turn on.
 */
export function slackMovedElsewhereText(
  computerName: string,
  appName: string,
): string {
  return `Mentions now start work on ${computerName}. If it isn't listening for Slack yet, open ${appName} on it and select Turn on.`;
}

/**
 * A paused link. Pause and Resume live on External agents, beside the
 * connection's computer and access, so the Slack section only says where.
 */
export function slackPausedLinkText(externalAgentsLabel: string): string {
  return `Paused. Resume it under ${externalAgentsLabel}.`;
}

export function slackAttentionText(
  reason: SlackLinkAttentionReason | null,
  appName: string,
): string {
  switch (reason) {
    case 'not_installed':
      return `${appName} is no longer in this Slack workspace. Add it again (a Slack admin may need to approve it), then connect again.`;
    case 'desktop_unpaired':
      return 'Its computer is no longer paired for agents. Connect again to pair it.';
    case 'account_inactive':
      return "Your account can't take Slack requests right now.";
    case 'not_enabled':
      return SLACK_UNAVAILABLE_TEXT;
    case 'connection_invalid':
    case 'client_disabled':
    case null:
      return "This Slack connection can't be used. Connect again to replace it.";
  }
}

/** A linked computer's own row, on desktop, while it isn't listening. */
export const SLACK_THIS_COMPUTER_NOT_LISTENING_TEXT =
  "This computer isn't listening for Slack mentions.";

/** Turning listening on or off on this desktop didn't save. */
export const SLACK_LISTEN_SAVE_FAILED_TEXT =
  "Couldn't change Slack mentions on this computer. Try again.";

/** Web, no computer paired for agents yet. */
export const SLACK_NO_COMPUTER_TITLE = 'No computer set up for agents yet';

export function slackNoComputerText(
  appName: string,
  externalAgentsLabel: string,
): string {
  return `Install ${appName} on the computer Slack should reach, sign in, and click Connect Slack there. Already installed? Pair it under ${externalAgentsLabel}.`;
}

/**
 * `?slack=` outcomes the link callback returns with, and the two a desktop
 * hand-off (`/slack/connect?intent=…`) returns with when it can't start.
 */
export const SLACK_CALLBACK_OUTCOMES = [
  'linked',
  'cancelled',
  'not_installed',
  'failed',
  'expired',
  'unavailable',
  'forwarded_workspace',
  'computer_not_paired',
  'too_many_attempts',
] as const;
export type SlackCallbackOutcome = (typeof SLACK_CALLBACK_OUTCOMES)[number];

export function isSlackCallbackOutcome(
  value: string | null,
): value is SlackCallbackOutcome {
  return SLACK_CALLBACK_OUTCOMES.some((outcome) => outcome === value);
}

/** A `?slack=` outcome that shows a notice. A new link shows none: the
 * header's dot and the new row say it. */
export type SlackCallbackNoticeOutcome = Exclude<
  SlackCallbackOutcome,
  'linked'
>;

export function slackCallbackOutcomeText(
  outcome: SlackCallbackNoticeOutcome,
  appName: string,
): string {
  switch (outcome) {
    case 'cancelled':
      return 'Slack sign-in was cancelled.';
    case 'not_installed':
      return `Add ${appName} to your Slack workspace first. A Slack admin may need to approve it. Then connect again.`;
    case 'failed':
      return "Couldn't connect Slack. Try again.";
    case 'expired':
      return 'The Slack sign-in took too long. Try again.';
    case 'unavailable':
      return SLACK_UNAVAILABLE_TEXT;
    case 'forwarded_workspace':
      // Only the team's own workspace (CAN-7905) can reach this: production
      // forwards its events to staging and refuses to link it here.
      return 'This Slack workspace connects to staging. Connect Slack from staging instead.';
    case 'computer_not_paired':
    case 'too_many_attempts':
      return slackStartRefusalText(outcome);
  }
}

/** Start refusals that show a message; `intent_invalid` never does. */
export function slackStartRefusalText(
  reason: Exclude<SlackLinkStartRefusal, 'intent_invalid'>,
): string {
  switch (reason) {
    case 'unavailable':
      return SLACK_UNAVAILABLE_TEXT;
    case 'computer_not_paired':
      return 'That computer is no longer paired for agents. Pick another or pair it again.';
    case 'too_many_attempts':
      return 'Too many unfinished Slack connections. Wait a few minutes and try again.';
    case 'failed':
      return "Couldn't start Slack sign-in. Try again.";
  }
}

/** Desktop Connect Slack refusals, after "Connecting didn't finish." */
export function slackConnectRefusalText(
  reason: SlackConnectThisComputerRefusal,
  appName: string,
): string {
  switch (reason) {
    case 'not_enabled':
      return SLACK_UNAVAILABLE_TEXT;
    case 'signed_out':
      return `Sign in to ${appName} to connect Slack.`;
    case 'identity_changed':
      return 'Your account changed while connecting. Try again.';
    case 'personal_account_required':
      return 'Pairing a computer for agents needs a personal account.';
    case 'entitlement_denied':
    case 'feature_disabled':
    case 'device_relay_not_configured':
      return "Your account can't pair computers for agents.";
    case 'entitlement_unavailable':
      return "Couldn't check your account. Try again.";
    case 'hosted_pairing_busy':
      return 'Another pairing is in progress. Try again in a moment.';
    case 'hosted_capacity':
      return 'Pairing is busy right now. Try again in a few minutes.';
    case 'forbidden':
      return "This computer isn't signed in to this account. Sign in again, then try again.";
    case 'denied':
      return 'Pairing was declined on this computer.';
    case 'offline':
      return "This computer couldn't be reached for pairing. Check your connection and try again.";
    case 'host_unsupported':
      return `Update ${appName} to connect Slack.`;
    case 'timeout':
      return 'Pairing took too long. Try again.';
    case 'failed':
    case 'link_failed':
      return "Couldn't pair this computer. Try again.";
    case 'too_many_attempts':
      return 'Too many unfinished Slack connections. Wait a few minutes and try again.';
    case 'browser_failed':
      return "Couldn't open your browser. Try again.";
  }
}

export const SLACK_CONNECT_UNFINISHED_TITLE = "Connecting didn't finish.";
export const SLACK_CONTINUE_IN_BROWSER_TEXT =
  'Finish connecting in your browser.';
