// User-facing copy for the revisioned chat-state recovery states (frontend
// plan, "Required UI Behavior"). Central so tests, the store, and the UI all
// render the exact approved strings.

/** Toast shown while a delta gap forces a one-shot snapshot refresh. */
export const CHAT_STATE_REFRESHING_TOAST = 'Chat state changed. Refreshing…';

/** Inline error heading when the gap-recovery refresh fails. */
export const CHAT_STATE_REFRESH_ERROR_HEADING =
  'Chat state couldn’t be refreshed';

/** Inline error helper below the heading. */
export const CHAT_STATE_REFRESH_ERROR_HELPER =
  'Your last loaded transcript is still shown. Try again to load the latest state.';

/** Heading when a task's chats never loaded, so there is no transcript to keep. */
export const CHAT_STATE_LOAD_ERROR_HEADING = 'Couldn’t load this task’s chats';

/** Inline error action label. */
export const CHAT_STATE_REFRESH_RETRY_LABEL = 'Try again';

/**
 * Shown when a destructive command was rejected as stale (conflict). The
 * notice leads with `CHAT_STATE_CONFLICT_TITLE` and this message follows it
 * on the same line.
 */
export const CHAT_STATE_CONFLICT_TITLE = 'Chat changed elsewhere';
export const CHAT_STATE_CONFLICT_NOTICE = 'Your view has been refreshed.';

/**
 * Shown when a non-conflict command failure rolled back one overlay. Same
 * title-then-message shape as the conflict notice.
 */
export const CHAT_STATE_COMMAND_FAILED_TITLE = 'Change not saved';
export const CHAT_STATE_COMMAND_FAILED_NOTICE = 'Try again.';
