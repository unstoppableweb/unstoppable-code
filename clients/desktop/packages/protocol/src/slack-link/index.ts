/**
 * Desktop Connect Slack wire contract (CAN-7606, plan 5b).
 *
 * Desktop main calls two web routes with its own `csk_` key:
 *
 * - `POST /api/v1/slack/link/desktop-connect/prepare` checks that this
 *   computer's relay device belongs to the account and that hosted admission
 *   would admit it, and returns the account's hosted root relay device id,
 *   which the desktop arms its prompt-free pairing expectation with.
 * - `POST /api/v1/slack/link/desktop-connect` pairs this computer for agents
 *   when needed and mints a single-use connect intent, which the browser
 *   page the desktop opens redeems through the link start route.
 *
 * Both answer `{ error: <refusal>, code: <refusal> }` on any refusal; the
 * codes are below.
 */
import { z } from 'zod';
import {
  DEVICE_ID_PATTERN,
  DEVICE_RELAY_INSTALL_ID_PATTERN,
} from '../device-relay';

export const SLACK_DESKTOP_CONNECT_PREPARE_PATH =
  '/api/v1/slack/link/desktop-connect/prepare';
export const SLACK_DESKTOP_CONNECT_PATH = '/api/v1/slack/link/desktop-connect';

/**
 * The longest desktop-connect waits for a pairing before it answers
 * `timeout` and cancels it. A prompt-free pairing finishes in seconds.
 */
export const SLACK_DESKTOP_CONNECT_PAIRING_TIMEOUT_MS = 60_000;

/** This computer: its relay device and its install id. */
export const slackDesktopConnectPrepareRequestSchema = z.strictObject({
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  installId: z.string().regex(DEVICE_RELAY_INSTALL_ID_PATTERN),
});
export type SlackDesktopConnectPrepareRequest = z.infer<
  typeof slackDesktopConnectPrepareRequestSchema
>;

export const slackDesktopConnectPrepareResponseSchema = z.strictObject({
  /** The account's hosted root relay device id. */
  controllerDeviceId: z.string().regex(DEVICE_ID_PATTERN),
});
export type SlackDesktopConnectPrepareResponse = z.infer<
  typeof slackDesktopConnectPrepareResponseSchema
>;

export const slackDesktopConnectRequestSchema = z.strictObject({
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  installId: z.string().regex(DEVICE_RELAY_INSTALL_ID_PATTERN),
  /**
   * Pair again even when the web still records this computer as paired: the
   * desktop sets it when it holds no hosted controller of its own.
   */
  repair: z.boolean(),
});
export type SlackDesktopConnectRequest = z.infer<
  typeof slackDesktopConnectRequestSchema
>;

export const slackDesktopConnectResponseSchema = z.strictObject({
  /** Single use, 5 minutes; redeemed by the link start route. */
  intent: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type SlackDesktopConnectResponse = z.infer<
  typeof slackDesktopConnectResponseSchema
>;

/** Request and account refusals both routes share. */
export const SLACK_DESKTOP_CONNECT_REQUEST_REFUSALS = [
  /** Missing, invalid or revoked key (401). */
  'unauthorized',
  /** Guest or service-account key, or an account that isn't active (403). */
  'forbidden',
  /** The Slack mentions flag is off for this account (404). */
  'not_enabled',
  /** Malformed body (400). */
  'invalid_request',
  /** The relay device or install isn't this account's (404). */
  'device_not_found',
] as const;

/** Hosted admission refusals, as `/api/v1/mcp/remotes/pair` answers them. */
export const SLACK_DESKTOP_CONNECT_ADMISSION_REFUSALS = [
  'entitlement_denied',
  'personal_account_required',
  'feature_disabled',
  'hosted_pairing_busy',
  'hosted_capacity',
  'entitlement_unavailable',
  'device_relay_not_configured',
] as const;

/** Pairing outcomes other than success (desktop-connect only). */
export const SLACK_DESKTOP_CONNECT_PAIRING_REFUSALS = [
  'denied',
  'offline',
  'host_unsupported',
  'timeout',
  'failed',
  'link_failed',
] as const;

export const SLACK_DESKTOP_CONNECT_REFUSALS = [
  ...SLACK_DESKTOP_CONNECT_REQUEST_REFUSALS,
  ...SLACK_DESKTOP_CONNECT_ADMISSION_REFUSALS,
  ...SLACK_DESKTOP_CONNECT_PAIRING_REFUSALS,
  /** Five unexpired intents already pending for the account (429). */
  'too_many_attempts',
  /** A store or server failure (503). */
  'unavailable',
] as const;
export type SlackDesktopConnectRefusal =
  (typeof SLACK_DESKTOP_CONNECT_REFUSALS)[number];

export const slackDesktopConnectRefusalResponseSchema = z.strictObject({
  error: z.enum(SLACK_DESKTOP_CONNECT_REFUSALS),
  /** The same code, where the desktop cloud client reads it (`serverCode`). */
  code: z.enum(SLACK_DESKTOP_CONNECT_REFUSALS),
});
export type SlackDesktopConnectRefusalResponse = z.infer<
  typeof slackDesktopConnectRefusalResponseSchema
>;
