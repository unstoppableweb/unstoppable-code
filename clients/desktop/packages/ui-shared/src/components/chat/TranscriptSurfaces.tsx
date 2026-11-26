import type { HTMLAttributes, JSX, ReactNode, Ref } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

type TranscriptSurfaceProps = HTMLAttributes<HTMLDivElement> & {
  readonly ref?: Ref<HTMLDivElement>;
};

/**
 * A section's sticky head. With a pinned turn header inside it, the head keeps
 * the 4px under the header's hairline as its own padding: this wrapper paints
 * nothing there, so the backing ends at the hairline.
 */
export function StickyPromptSurface(
  props: TranscriptSurfaceProps,
): JSX.Element {
  return (
    <div
      {...props}
      className="group/sticky sticky top-0 z-20 has-[[data-turn-header]]:pb-1 before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-base"
    />
  );
}

/**
 * Fades the transcript in below the pinned head, so content scrolls out under
 * a soft edge rather than a hard line. Shows only while the head is stuck
 * (`data-stuck`): at rest nothing passes under it.
 */
export function StickyPromptFade(): JSX.Element {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-full hidden h-3 bg-gradient-to-b from-base to-transparent group-data-[stuck]/sticky:block"
    />
  );
}

/**
 * The pinned head's opaque backing: the prompt and the turn header under it.
 * Its bottom edge is the seam content scrolls under (`data-sticky-backing`).
 * Always painted, so the head is covered on the first frame it pins rather
 * than once a scroll handler marks it; at rest it sits on the same surface
 * color and does not show.
 */
export function StickyPromptBacking({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="relative bg-base" data-sticky-backing="">
      {children}
    </div>
  );
}

export function TranscriptReadingColumn(
  props: TranscriptSurfaceProps,
): JSX.Element {
  return (
    <div
      {...props}
      className={`${REPLAY_BLOCK_CLASS} mx-auto flex w-full max-w-[var(--chat-reading-width)] flex-col gap-2 chat-width-transition [&>*]:shrink-0 [&_[data-chat-call-focus]]:rounded-lg [&_[data-chat-call-focus]]:ring-2 [&_[data-chat-call-focus]]:ring-line-accent`}
    />
  );
}

export function TranscriptTurnSection(
  props: TranscriptSurfaceProps,
): JSX.Element {
  return (
    <div
      {...props}
      className="relative flex flex-col gap-2 rounded-lg transition-shadow data-[chat-turn-focus]:ring-2 data-[chat-turn-focus]:ring-line-accent"
    />
  );
}

export function RevertedTurnSurface({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      aria-label="Reverted turn"
      className="flex flex-col -ml-3 border-l-2 border-line-attention/40 pl-3 opacity-60 gap-2"
    >
      {children}
    </div>
  );
}
