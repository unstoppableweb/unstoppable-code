import type { JSX, ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { DialogModal } from '../primitives/DialogModal';
import { SPACE_ROLE_GAP_CLASS, type SpaceRole } from '../primitives/Stack';

const CONTENT_CLASS = 'px-6 pb-6';

/**
 * The plugins surface's detail dialog (an MCP server, a skill): the shared
 * dialog with the item's name, an optional badge beside it, and its details
 * below. Closing it (the close button, Escape or the scrim) goes back to the
 * list it opened from.
 */
export function BackDetailOverlayShell({
  title,
  titleId,
  onBack,
  badge,
  badgeGap,
  children,
  blockContentFromReplay = false,
}: {
  title: string;
  titleId: string;
  onBack: () => void;
  badge?: ReactNode;
  /** Opt-in title-to-badge gap for a badge without an outer margin. */
  badgeGap?: SpaceRole;
  children: ReactNode;
  /**
   * Mark only the scrolling content area with the session-replay block class,
   * for a body that is file content (such as a SKILL.md file). The header,
   * close button, and title stay recorded.
   */
  blockContentFromReplay?: boolean;
}): JSX.Element {
  return (
    <DialogModal
      onClose={onBack}
      title={
        badge ? (
          <span
            className={`flex min-w-0 items-center ${SPACE_ROLE_GAP_CLASS[badgeGap ?? 'inline']}`}
          >
            <span className="truncate">{title}</span>
            {badge}
          </span>
        ) : (
          title
        )
      }
      titleId={titleId}
      maxWidth="2xl"
      headerBorder={false}
      inset="flush"
      trapFocus
    >
      <div
        className={
          blockContentFromReplay
            ? `${REPLAY_BLOCK_CLASS} ${CONTENT_CLASS}`
            : CONTENT_CLASS
        }
      >
        {children}
      </div>
    </DialogModal>
  );
}
