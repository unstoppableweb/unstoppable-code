import { z } from 'zod';
import type { AgentJsonSchema } from './definition';

/** The shortest and longest delay a wakeup may be scheduled after. */
export const SCHEDULE_WAKEUP_MIN_DELAY_SECONDS = 60;
export const SCHEDULE_WAKEUP_MAX_DELAY_SECONDS = 3600;
/** The longest follow-up instruction a wakeup carries. */
export const SCHEDULE_WAKEUP_FOLLOW_UP_MAX_LENGTH = 8000;

export const scheduleWakeupInputSchema = z
  .object({
    delaySeconds: z
      .number()
      .int()
      .min(SCHEDULE_WAKEUP_MIN_DELAY_SECONDS)
      .max(SCHEDULE_WAKEUP_MAX_DELAY_SECONDS),
    followUpInstruction: z
      .string()
      .max(SCHEDULE_WAKEUP_FOLLOW_UP_MAX_LENGTH)
      .optional(),
  })
  .strict();

export type ScheduleWakeupInput = z.infer<typeof scheduleWakeupInputSchema>;

export const SCHEDULE_WAKEUP_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  properties: {
    delaySeconds: {
      type: 'integer',
      minimum: SCHEDULE_WAKEUP_MIN_DELAY_SECONDS,
      maximum: SCHEDULE_WAKEUP_MAX_DELAY_SECONDS,
    },
    followUpInstruction: {
      type: 'string',
      maxLength: SCHEDULE_WAKEUP_FOLLOW_UP_MAX_LENGTH,
    },
  },
  required: ['delaySeconds'],
  additionalProperties: false,
};

/**
 * The ScheduleWakeup description. Desktop keeps its deadline in the app, so
 * delivery waits for the app to run, and offers WatchCommand beside it; a
 * cloud chat's wakeup is kept and delivered by the server whether or not the
 * app is open, and is dropped for a chat archived or deleted before it is
 * due.
 */
export function scheduleWakeupDescription(
  options:
    | { delivery: 'app'; watchCommandName: string }
    | { delivery: 'cloud' },
): string {
  const lead =
    'Schedule one wakeup in this same chat after delaySeconds (integer 60–3600). Retrying with the same delay and follow-up instruction while that wakeup is still pending returns it with its original time instead of scheduling another. Uses the watcher system; list or cancel with SearchWatchers and DeleteWatchers. End the turn after registration instead of sleeping.';
  if (options.delivery === 'app') {
    return `${lead} The deadline survives app restarts; delivery happens when the app is running. Destination is captured server-side. Use this instead of ${options.watchCommandName} for time-based waiting.`;
  }
  return `${lead} The wakeup is kept on the server and arrives once, usually within about a minute of its due time, whether or not the app is open; a chat archived or deleted before then gets nothing. Destination is captured server-side.`;
}
