import { z } from 'zod';

/**
 * How much of an agent's work a chat transcript shows (Appearance → "Chat
 * detail"), from most to least:
 * - `detailed`: every step is its own row;
 * - `recent`: back-to-back steps fold into one row ("Ran 3 commands"), and
 *   while the turn runs its newest steps stay in view under that row;
 * - `compact`: back-to-back steps fold into one row; open it to see each step.
 *   While the turn runs, one status line under it says what it does now.
 * Once a turn finishes, `recent` and `compact` look the same, except that
 * `compact` keeps a single step as a closed line too.
 */
export const CHAT_DETAILS = ['detailed', 'recent', 'compact'] as const;

export type ChatDetail = (typeof CHAT_DETAILS)[number];

/** Used when nothing is saved yet. */
export const DEFAULT_CHAT_DETAIL: ChatDetail = 'recent';

export const chatDetailSchema = z.enum(CHAT_DETAILS);

export function isChatDetail(value: unknown): value is ChatDetail {
  return chatDetailSchema.safeParse(value).success;
}

/** A saved value, or the default when it is missing or not a known level. */
export function normalizeChatDetail(value: unknown): ChatDetail {
  return isChatDetail(value) ? value : DEFAULT_CHAT_DETAIL;
}

/** Newest steps a `recent` transcript keeps in view while a turn runs. */
export const RECENT_STEP_COUNT = 3;

/**
 * Web Account → Appearance (`/api/account/appearance`): the account's saved
 * chat detail level. The read and the update both answer with it.
 */
export const accountAppearanceSchema = z.strictObject({
  chatDetail: chatDetailSchema,
});

export type AccountAppearance = z.infer<typeof accountAppearanceSchema>;
