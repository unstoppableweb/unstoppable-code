/** Browser-safe replay privacy vocabulary shared by the recorder options and
 * renderer components. Plain string constants only: the renderer, the
 * recorder options, and the preload-reachable modules all read this file.
 *
 * `@canopy/ui-shared/lib/replay-privacy` holds the UI packages' copy of these
 * values under different names; a desktop parity test keeps them equal. */

/** Block. The recorder serializes an element carrying this class as a
 * same-size placeholder and records nothing inside it, including input events
 * from inputs inside it. Read by rrweb's `blockClass`. */
export const POSTHOG_REPLAY_BLOCK_CLASS = 'ph-no-capture';

/** Mask. The recorder replaces every visible character of text inside an
 * element carrying this class with `*`, keeping spaces, so a user-authored
 * title keeps its shape but cannot be read, and replaces the attributes that
 * can carry that content (`placeholder`, `title`, `aria-label`, `data-value`
 * and the like) with a fixed mask. Clicks and focus on it are still recorded.
 * Read by `recordReplayText` and `maskReplayAttribute`. */
export const POSTHOG_REPLAY_MASK_CLASS = 'ph-mask';
