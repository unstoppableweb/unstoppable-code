import { z } from 'zod';

export const SLACK_THREAD_ACTION_TYPES = [
  'slack_thread.read',
  'slack_thread.open_file',
] as const;

/** A signed cursor or file handle from an earlier read: opaque here. */
const slackThreadTokenSchema = z
  .string()
  .min(3)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/**
 * Reads the Slack thread behind the request in the Orchestrator's own Slack
 * tab (CAN-7749). Neither action names a channel, thread or chat: the host
 * takes the tab from the turn, and the hosted service reads only the thread
 * recorded for it, up to the request message.
 */
export const slackThreadActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('slack_thread.read'),
    /** `nextCursor` from the previous read; the first page without. */
    cursor: slackThreadTokenSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('slack_thread.open_file'),
    /** A file's `handle` from a `slack_thread.read` of this tab. */
    handle: slackThreadTokenSchema,
  }),
]);

export type SlackThreadAction = z.infer<typeof slackThreadActionSchema>;
