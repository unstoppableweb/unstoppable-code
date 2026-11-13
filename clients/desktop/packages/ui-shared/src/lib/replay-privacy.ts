// Session-replay privacy markers for the UI packages (ui-shared, ui-rich,
// ui-app). These packages cannot import `@canopy/desktop-instrumentation`, so
// they carry their own copy of the recorder's classes. The values are fixed:
// a desktop parity test fails if they drift from the instrumentation
// package's `POSTHOG_REPLAY_BLOCK_CLASS` and `POSTHOG_REPLAY_MASK_CLASS`. Web
// has no session replay, so the classes are inert there.

/** Block. The recorder (rrweb `blockClass`) serializes an element carrying this
 * class as a same-size placeholder and records nothing inside it. Put it on an
 * element that mounts together with the content it hides. */
export const REPLAY_BLOCK_CLASS = 'ph-no-capture';

/** Mask. The recorder replaces every visible character of text inside an
 * element carrying this class with `*`, keeping spaces, and replaces the
 * attributes that can carry that content (`placeholder`, `title`,
 * `aria-label`, `data-value` and the like) with a fixed mask. Put it on the
 * text element of a user-authored project, chat, tab, or worktree title,
 * never on the row, tab, or button around it, or around a field whose
 * placeholder is conversation content. */
export const REPLAY_MASK_CLASS = 'ph-mask';
