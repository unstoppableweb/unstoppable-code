/**
 * Usage analytics opt-out ping wire contract (CAN-6069).
 *
 * An install with Usage analytics turned off sends nothing to PostHog, so the
 * desktop sends this one anonymous daily ping instead, and the web stores only
 * an aggregate count per (UTC day, reason, channel).
 *
 * Route: `POST /api/usage-analytics/opt-out` (public, always 204).
 *
 * Privacy rule: the body is exactly `{ reason, channel }`. It carries no
 * install id, device id, account, organization or person identifier, and the
 * request carries no credentials or cookies. Do not add a field without a
 * privacy review.
 *
 * `channel` follows the desktop release flavor that PostHog reports as
 * `release_channel`; a development build has none and sends no ping.
 */
import { z } from 'zod';
import type { BrandReleaseFlavor } from '../brand';

export const USAGE_ANALYTICS_OPT_OUT_PATH = '/api/usage-analytics/opt-out';

/** `personal`: the person turned it off. `org`: the `usage-data` policy did. */
export const USAGE_ANALYTICS_OPT_OUT_REASONS = ['personal', 'org'] as const;
/** Every packaged release flavor; `satisfies` keeps it inside the brand list. */
export const USAGE_ANALYTICS_OPT_OUT_CHANNELS = [
  'internal',
  'rc',
  'stable',
] as const satisfies readonly BrandReleaseFlavor[];

export const UsageAnalyticsOptOutPingSchema = z
  .object({
    reason: z.enum(USAGE_ANALYTICS_OPT_OUT_REASONS),
    channel: z.enum(USAGE_ANALYTICS_OPT_OUT_CHANNELS),
  })
  .strict();

export type UsageAnalyticsOptOutPing = z.output<
  typeof UsageAnalyticsOptOutPingSchema
>;
