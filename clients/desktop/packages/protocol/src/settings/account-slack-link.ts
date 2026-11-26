import { z } from 'zod';

/**
 * Account → Integrations → Slack (CAN-7606): the person's Slack account links.
 * Each link ties one Slack user, proven by Sign in with Slack, to this account
 * and one computer paired for agents, through a first-party "Slack" agent
 * connection. One account can hold one link per Slack workspace.
 *
 * The read reports whether linking is available and, for each active link,
 * the status the mention resolver would act on, so the panel and the
 * resolver can't disagree. Linking itself is a browser round trip through
 * Slack (`/api/v1/slack/link/start`), not a settings operation. A desktop
 * connecting another of the person's computers first mints a connect intent
 * (`account.slack.link.intent`) and opens the hand-off page with it. Moving
 * a link to another computer (`account.slack.link.move`) needs no new Slack
 * sign-in: the Slack user is already proven and both computers are the
 * person's own.
 */

/** The Slack link settings API path, for the web route and both hosts. */
export const ACCOUNT_SLACK_LINKS_PATH = '/api/v1/settings/slack-links';

/** `account.slack.link.intent`: mint a connect intent for one computer. */
export const ACCOUNT_SLACK_LINK_INTENTS_PATH = `${ACCOUNT_SLACK_LINKS_PATH}/intents`;

/**
 * The web's Connect Slack hand-off. Opened signed in with `?intent=…`, it
 * redeems the intent and goes straight to Slack's consent page.
 */
export const SLACK_CONNECT_HANDOFF_PATH = '/slack/connect';

/** The hand-off page for a connect intent. */
export function slackConnectHandoffPath(intent: string): string {
  return `${SLACK_CONNECT_HANDOFF_PATH}?intent=${encodeURIComponent(intent)}`;
}

/** One link's path; `linkId` is the link's external id. */
export function accountSlackLinkPath(linkId: string): string {
  return `${ACCOUNT_SLACK_LINKS_PATH}/${encodeURIComponent(linkId)}`;
}

/**
 * Why linking is unavailable for this account. `not_configured`: this
 * deployment has no Slack app config. `client_disabled`: Slack links are
 * switched off for everyone. The rest are the hosted Remote Control
 * admission refusals pairing a computer would hit.
 */
export const SLACK_LINK_UNAVAILABLE_REASONS = [
  'not_configured',
  'client_disabled',
  'personal_account_required',
  'entitlement_denied',
  'entitlement_unavailable',
  'device_relay_not_configured',
] as const;

export type SlackLinkUnavailableReason =
  (typeof SLACK_LINK_UNAVAILABLE_REASONS)[number];

/**
 * Why an active link can't carry mentions right now, as the resolver would
 * refuse it. `not_installed`: the bot is no longer installed in the workspace
 * that authorized the link. `desktop_unpaired`: the computer is no longer
 * paired for agents. The others mean the connection can't be used.
 */
export const SLACK_LINK_ATTENTION_REASONS = [
  'not_installed',
  'not_enabled',
  'account_inactive',
  'connection_invalid',
  'client_disabled',
  'desktop_unpaired',
] as const;

export type SlackLinkAttentionReason =
  (typeof SLACK_LINK_ATTENTION_REASONS)[number];

export const SLACK_LINK_STATUSES = [
  'active',
  'paused',
  'needs_attention',
] as const;

export type SlackLinkStatus = (typeof SLACK_LINK_STATUSES)[number];

export const slackLinkComputerSchema = z.looseObject({
  /** The computer's remote id, as connection policies store it. */
  remoteId: z.string().min(1),
  name: z.string(),
  online: z.boolean(),
  /**
   * The computer's relay device id, so a desktop can tell which entry is
   * itself (it shows its own Linked row instead of Connect Slack). Optional
   * for version skew; `null` when the server doesn't know it.
   */
  deviceId: z.string().min(1).nullable().optional(),
});

export type SlackLinkComputer = z.infer<typeof slackLinkComputerSchema>;

export const slackAccountLinkSchema = z.looseObject({
  linkId: z.string().min(1),
  /** The Slack workspace's name, as Slack reported it at sign-in. */
  workspaceName: z.string(),
  /** The Slack workspace whose bot install authorized the link. */
  workspaceId: z.string().min(1),
  computer: slackLinkComputerSchema,
  status: z.enum(SLACK_LINK_STATUSES),
  /** Set only when `status` is `needs_attention`. */
  attentionReason: z.enum(SLACK_LINK_ATTENTION_REASONS).nullable(),
  /** ISO 8601. */
  linkedAt: z.string().min(1),
});

export type SlackAccountLink = z.infer<typeof slackAccountLinkSchema>;

export const accountSlackLinksSchema = z.looseObject({
  available: z.boolean(),
  /** Set only when `available` is false. */
  unavailableReason: z.enum(SLACK_LINK_UNAVAILABLE_REASONS).nullable(),
  /** Active links, newest first. Revoked or expired connections are absent. */
  links: z.array(slackAccountLinkSchema),
  /** Computers paired for agents (not pending removal) a link may use. */
  computers: z.array(slackLinkComputerSchema),
});

export type AccountSlackLinks = z.infer<typeof accountSlackLinksSchema>;

export const accountSlackLinkInputSchema = z.strictObject({
  linkId: z.string().uuid(),
});

export type AccountSlackLinkInput = z.infer<typeof accountSlackLinkInputSchema>;

/** A computer paired for agents, by its remote id, to connect Slack to. */
export const accountSlackLinkIntentInputSchema = z.strictObject({
  remoteId: z.string().min(1).max(64),
});

export type AccountSlackLinkIntentInput = z.infer<
  typeof accountSlackLinkIntentInputSchema
>;

/**
 * Why no connect intent was minted. `computer_not_paired`: the computer isn't
 * the account's, or isn't paired for agents. `too_many_attempts`: too many
 * unfinished connects for this account. Where Slack isn't offered the
 * operation answers not found, as the read does.
 */
export const SLACK_LINK_INTENT_REFUSALS = [
  'computer_not_paired',
  'too_many_attempts',
] as const;

export type SlackLinkIntentRefusal =
  (typeof SLACK_LINK_INTENT_REFUSALS)[number];

/**
 * A single-use connect intent (5 minutes) for the computer, for the hand-off
 * page to redeem, or why there is none.
 */
export const accountSlackLinkIntentResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), intent: z.string().min(16).max(256) }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(SLACK_LINK_INTENT_REFUSALS),
  }),
]);

export type AccountSlackLinkIntentResult = z.infer<
  typeof accountSlackLinkIntentResultSchema
>;

/** Points a link at another of the person's computers paired for agents. */
export const accountSlackLinkMoveInputSchema = z.strictObject({
  linkId: z.string().uuid(),
  remoteId: z.string().min(1).max(64),
});

export type AccountSlackLinkMoveInput = z.infer<
  typeof accountSlackLinkMoveInputSchema
>;

/**
 * Why a link didn't move. `computer_not_paired`: the computer isn't the
 * account's, or isn't paired for agents. `failed`: the connection couldn't
 * take the new computer. A link that isn't the caller's active link answers
 * not found, as Disconnect does.
 */
export const SLACK_LINK_MOVE_REFUSALS = [
  'computer_not_paired',
  'failed',
] as const;

export type SlackLinkMoveRefusal = (typeof SLACK_LINK_MOVE_REFUSALS)[number];

export const accountSlackLinkMoveResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(SLACK_LINK_MOVE_REFUSALS),
  }),
]);

export type AccountSlackLinkMoveResult = z.infer<
  typeof accountSlackLinkMoveResultSchema
>;
