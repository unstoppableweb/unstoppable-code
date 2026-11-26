import { memo, type JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { DisplayAvatar } from '../primitives/DisplayAvatar';

export interface SharedChatAuthorHeaderProps {
  readonly author: {
    readonly name: string;
    readonly image?: string;
  };
}

export const SharedChatAuthorHeader = memo(function SharedChatAuthorHeader({
  author,
}: SharedChatAuthorHeaderProps): JSX.Element {
  return (
    <span
      className="flex items-center gap-2 text-xs font-medium fg-secondary"
      data-testid="shared-chat-turn-author"
    >
      <DisplayAvatar name={author.name} image={author.image} size="sm" />
      {/* A person's name: replay records a same-size box. */}
      <span className={REPLAY_BLOCK_CLASS}>{author.name}</span>
    </span>
  );
});
