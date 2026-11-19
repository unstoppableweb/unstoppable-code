import type { JSX } from 'react';
import { ActionTooltip } from '@/components/shared/ActionTooltip';
import { openRunComments } from '@/stores/runCommentsStore';
import {
  Button,
  CLEAN_ICON_BUTTON_VARIANT,
  Count,
} from '@canopy/ui-shared/components';
import { MessageIcon as AppCatalogMessageIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatBadgeCount } from '@canopy/ui-shared/lib';

/**
 * Turn-footer affordance opening the shared-run comments panel (CAN-397), with
 * an unread badge fed by the main-process comment poller. Only rendered for a
 * chat that has actually been shared as a run.
 */
export function RunCommentsButton({
  projectId,
  worktreeId,
  chatId,
  title,
  unreadCount = 0,
  testId = 'turn-run-comments',
}: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  title: string;
  unreadCount?: number;
  testId?: string;
}): JSX.Element {
  const label =
    unreadCount > 0
      ? `Run comments (${formatBadgeCount(unreadCount)})`
      : 'Run comments';
  return (
    <ActionTooltip
      title="Run comments"
      description="Read and reply to comments reviewers left on this shared run."
    >
      <span className="relative inline-flex">
        <Button
          variant={unreadCount > 0 ? 'ghost' : CLEAN_ICON_BUTTON_VARIANT}
          size="sm"
          iconOnly
          onClick={(): void => {
            openRunComments({ projectId, worktreeId, chatId, title });
          }}
          aria-label={label}
          data-testid={testId}
          data-unread-count={String(unreadCount)}
          // Footer rows keep the unread accent instead of the muted icon look.
          data-attention={unreadCount > 0 ? '' : undefined}
        >
          <AppCatalogMessageIcon aria-hidden="true" />
        </Button>
        {unreadCount > 0 && (
          <Count
            value={unreadCount}
            placement="icon"
            tone="unread"
            aria-hidden
            data-testid={`${testId}-count`}
            className="pointer-events-none absolute -top-1 -right-1"
          />
        )}
      </span>
    </ActionTooltip>
  );
}
