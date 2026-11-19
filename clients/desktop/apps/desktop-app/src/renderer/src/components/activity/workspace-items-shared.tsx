/**
 * Shared building blocks for the Notes / Prompts / Attachments activity
 * cards (see `NotesSection.tsx`, `PromptsSection.tsx`,
 * `AttachmentsSection.tsx` in this directory).
 */
/* eslint-disable react-refresh/only-export-components */
import { useCallback, useState, type JSX, type ReactNode } from 'react';
import type { WorkspaceItemOrigin } from '@canopy/desktop-shared/types';
import {
  DEFAULT_WORKTREE_DISPLAY_NAME,
  isDefaultWorktreeBranchName,
} from '@canopy/desktop-shared/lib/default-worktree-branch';
import {
  InfoIcon,
  PlusMediumIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';
import { Button } from '@canopy/ui-shared/components';

/**
 * Inserts an @-mention pill into the visible composer via the ChatInput
 * `canopy:insert-file-reference` DOM listener. `kind` marks note / prompt /
 * attachment mentions for send-time handling (prompt expansion).
 */
export function dispatchWorkspaceItemMention(detail: {
  displayPath: string;
  absolutePath: string;
  repoName?: string;
  kind?: string;
}): void {
  document.dispatchEvent(
    new CustomEvent('canopy:insert-file-reference', { detail }),
  );
}

/**
 * Persistent info-icon trigger that carries an item's low-priority metadata —
 * created date and (in code workspaces) the "from <branch>" origin — in a
 * hover tooltip instead of consuming inline space. While the origin worktree
 * exists the branch name is live (renames show through); after deletion it
 * renders tombstoned (dimmed + strikethrough) so it reads as historical.
 */
export function ItemMetaInfo({
  createdAt,
  origin,
  extra,
}: {
  createdAt: string;
  origin?: WorkspaceItemOrigin;
  /** Optional extra tooltip line(s) rendered under the created/origin rows. */
  extra?: ReactNode;
}): JSX.Element {
  const branchLabel =
    origin !== undefined
      ? isDefaultWorktreeBranchName(origin.branchName, origin.worktreeId)
        ? DEFAULT_WORKTREE_DISPLAY_NAME
        : origin.branchName
      : null;
  return (
    <RichHoverTooltip
      surfaceClassName="w-max max-w-56"
      surfacePadding="relaxed"
      content={
        <span className="flex flex-col gap-0.5">
          <span className="text-3xs fg-secondary">
            Created {new Date(createdAt).toLocaleString()}
          </span>
          {origin !== undefined && branchLabel !== null && (
            <span
              className={
                origin.worktreeExists
                  ? 'text-3xs fg-primary'
                  : 'text-3xs fg-secondary/60 line-through'
              }
            >
              from {branchLabel}
              {origin.worktreeExists ? '' : ' (worktree deleted)'}
            </span>
          )}
          {extra}
        </span>
      }
    >
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        onClick={(e): void => e.stopPropagation()}
        aria-label="Item details"
      >
        <InfoIcon size="sm" />
      </Button>
    </RichHoverTooltip>
  );
}

// Compatibility exports keep desktop call sites stable while the pure row
// action primitives live in the cross-surface display package.
export {
  InlineDeleteConfirm,
  RowActionButton,
  RowActionTray,
  type InlineDeleteConfirmProps,
  type RowActionButtonProps,
  type RowActionTrayProps,
} from '@canopy/ui-shared/components';

export { MentionIcon } from '@canopy/ui-shared/icons';

export { PlusMediumIcon as PlusIcon, TrashIcon };

/** Row-level delete-with-confirm state helper shared by the three cards. */
export function useInlineDelete(onDelete: () => Promise<void>): {
  confirming: boolean;
  deleting: boolean;
  request: () => void;
  cancel: () => void;
  confirm: () => void;
} {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirm = useCallback((): void => {
    setDeleting(true);
    void onDelete().finally(() => {
      setDeleting(false);
      setConfirming(false);
    });
  }, [onDelete]);

  return {
    confirming,
    deleting,
    request: useCallback((): void => setConfirming(true), []),
    cancel: useCallback((): void => setConfirming(false), []),
    confirm,
  };
}
