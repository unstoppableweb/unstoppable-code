import { type JSX, useCallback, useRef, useState } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import {
  ActionMenuRowStyle,
  Button,
  MenuDivider,
  MenuItem,
  MenuItemIcon,
  MenuLabel,
  Menu,
} from '@canopy/ui-shared';
import {
  EyeOffIcon,
  MessageIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Tooltip } from '@canopy/ui-shared/components';
import { ShareRunModal } from '@/components/shared/ShareRunModal';
import { useShareRunAction } from '@/hooks/useShareRunAction';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { openRunComments } from '@/stores/runCommentsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { isCoworkChatTarget } from '@/lib/cowork';
import type { SharedRunMetadata } from '@canopy/desktop-shared/types';
import { useTeamOrgShareEntryVisible } from '@/lib/share-targets';

const BASE_TEST_ID = 'share-session-control';
const SHARE_LABEL = 'Share session';
const RESHARE_LABEL = 'Share again';
const UNSHARE_LABEL = 'Unshare';
const UNSHARING_LABEL = 'Unsharing…';
const COMMENTS_LABEL = 'Comments';

/** Menu/aria label carrying the unread-comment count when there is one. */
function commentsLabel(unreadCount: number): string {
  return unreadCount > 0
    ? `${COMMENTS_LABEL} (${unreadCount > 9 ? '9+' : unreadCount})`
    : COMMENTS_LABEL;
}

export type ShareSessionControlVariant = 'icon-button' | 'menu-item';

export interface ShareSessionControlProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
  title: string;
  hasMessages: boolean;
  busy: boolean;
  sharedRun?: SharedRunMetadata;
  variant: ShareSessionControlVariant;
  testId?: string;
  onAfterSelect?: () => void;
  onOpenShare?: (
    chatId: string,
    title: string,
    ownerDocument?: Document,
    existingShare?: SharedRunMetadata,
  ) => void;
}

/** Unified team and organization redacted session-sharing control. */
export function ShareSessionControl({
  projectId,
  worktreeId,
  chatId,
  title,
  hasMessages,
  busy,
  sharedRun,
  variant,
  testId,
  onAfterSelect,
  onOpenShare,
}: ShareSessionControlProps): JSX.Element {
  const share = useShareRunAction(projectId, worktreeId);
  const unshareRun = useActivityStore((state) => state.unshareRun);
  const addToast = useGitHubStore((state) => state.addToast);
  const [manageOpen, setManageOpen] = useState(false);
  const [unsharing, setUnsharing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const visibleSharedRun =
    sharedRun?.shareScope === 'private' ? undefined : sharedRun;
  const isShared = visibleSharedRun !== undefined;
  const shareEntryVisible = useTeamOrgShareEntryVisible(isShared);
  const shareDisabled = busy || !hasMessages;
  const resolvedTestId = testId ?? BASE_TEST_ID;
  // Comments left by reviewers since the user last opened the panel (CAN-397).
  // Tracked in `SharedRunMetadata` by the main-process poller — the desktop
  // never stores the comments themselves.
  const unreadComments = visibleSharedRun?.unreadCommentCount ?? 0;

  const openComments = useCallback((): void => {
    setManageOpen(false);
    openRunComments({ projectId, worktreeId, chatId, title });
  }, [chatId, projectId, title, worktreeId]);

  const openShareModal = useCallback(
    (ownerDocument?: Document): void => {
      setManageOpen(false);
      if (onOpenShare) {
        onOpenShare(chatId, title, ownerDocument, visibleSharedRun);
        onAfterSelect?.();
        return;
      }
      share.open(chatId, title, ownerDocument, visibleSharedRun);
    },
    [chatId, onAfterSelect, onOpenShare, share, title, visibleSharedRun],
  );

  const handleUnshare = useCallback((): void => {
    setUnsharing(true);
    void (async (): Promise<void> => {
      let canonicalCleared = false;
      try {
        await useChatStore
          .getState()
          .setSharedRun(projectId, worktreeId, chatId, undefined);
        canonicalCleared = true;
        const result = await unshareRun(projectId, worktreeId, chatId);
        if (isCoworkChatTarget(projectId)) {
          void useStandaloneChatStore.getState().refreshWorkEntries();
        }
        addToast(
          result.unshared ? 'Session unshared.' : 'Session already unshared.',
          'success',
          undefined,
          { projectId, worktreeId },
        );
      } catch (error) {
        if (canonicalCleared && sharedRun) {
          try {
            await useChatStore
              .getState()
              .setSharedRun(projectId, worktreeId, chatId, sharedRun);
          } catch {
            // Preserve the original cloud-revocation failure for the user.
          }
        }
        addToast('Failed to unshare session.', 'error', undefined, {
          caught: error,
          projectId,
          worktreeId,
        });
      } finally {
        setUnsharing(false);
        setManageOpen(false);
      }
    })();
  }, [addToast, chatId, projectId, sharedRun, unshareRun, worktreeId]);

  const modal = share.target !== null && (
    <ShareRunModal
      chatId={share.target.chatId}
      runTitle={share.target.title}
      ownerDocument={share.target.ownerDocument}
      existingShare={share.target.existingShare}
      onClose={(): void => {
        share.close();
        onAfterSelect?.();
      }}
      onShare={share.submit}
      checkEligibility={share.checkEligibility}
      onShared={async (result): Promise<void> => {
        await share.onShared(result);
        onAfterSelect?.();
      }}
    />
  );

  if (!shareEntryVisible) return <>{modal}</>;

  if (variant === 'menu-item') {
    if (!isShared) {
      return (
        <>
          <MenuItem
            disabled={shareDisabled}
            onClick={(event): void => {
              openShareModal(event.currentTarget.ownerDocument);
            }}
            data-testid={resolvedTestId}
          >
            <MenuItemIcon>
              <ShareIcon />
            </MenuItemIcon>
            <span>{SHARE_LABEL}</span>
          </MenuItem>
          {modal}
        </>
      );
    }
    return (
      <>
        <MenuItem
          onClick={(event): void => {
            openShareModal(event.currentTarget.ownerDocument);
          }}
          data-testid={resolvedTestId}
        >
          <MenuItemIcon>
            <ShareIcon />
          </MenuItemIcon>
          <span>{RESHARE_LABEL}</span>
        </MenuItem>
        <MenuItem
          onClick={(): void => {
            openComments();
            onAfterSelect?.();
          }}
          data-testid={`${resolvedTestId}-comments`}
        >
          <MenuItemIcon>
            <MessageIcon />
          </MenuItemIcon>
          <span>{commentsLabel(unreadComments)}</span>
        </MenuItem>
        {/* Ending the share is its own last group. */}
        <MenuDivider />
        <MenuItem
          disabled={unsharing}
          onClick={(): void => {
            handleUnshare();
            onAfterSelect?.();
          }}
          data-testid={`${resolvedTestId}-unshare`}
          tone="destructive"
        >
          <MenuItemIcon>
            <EyeOffIcon />
          </MenuItemIcon>
          <span>{unsharing ? UNSHARING_LABEL : UNSHARE_LABEL}</span>
        </MenuItem>
        {modal}
      </>
    );
  }

  const shareTargetName =
    visibleSharedRun?.teamName ?? visibleSharedRun?.organizationName;
  const manageHeader = shareTargetName
    ? `Shared to ${shareTargetName}`
    : 'Shared with your team or organization';

  return (
    <div className="relative">
      <Tooltip
        label={isShared ? 'Sharing settings' : `Share ${CHAT_UNIT_LABEL}`}
        description={
          isShared
            ? `Manage or unshare this ${CHAT_UNIT_LABEL}.`
            : `Share a redacted, read-only copy of this ${CHAT_UNIT_LABEL} with your team or organization.`
        }
      >
        <Button
          ref={buttonRef}
          variant="ghost"
          size="sm"
          iconOnly
          disabled={!isShared && shareDisabled}
          onClick={(event): void => {
            if (isShared) {
              setManageOpen((open) => !open);
            } else {
              openShareModal(event.currentTarget.ownerDocument);
            }
          }}
          aria-label={isShared ? 'Sharing settings' : SHARE_LABEL}
          aria-pressed={isShared}
          data-testid={resolvedTestId}
          data-shared={isShared ? 'true' : 'false'}
        >
          <ShareIcon size="sm" />
        </Button>
      </Tooltip>

      {/* No unread badge here by design. This icon-button variant only ever
          renders beside `RunCommentsButton` (both are gated on the same
          `sharedRun`), and that button already carries the badge plus the count
          in its accessible name. Two badges for one number read as two separate
          signals. The count still reaches this control's manage menu through
          the "Comments (N)" item below. */}
      {isShared && (
        <Menu
          open={manageOpen}
          onOpenChange={setManageOpen}
          anchorRef={buttonRef}
          placement="top-left"
          interaction="menu"
          // Each row closes the menu itself; Unshare keeps it open on
          // "Unsharing…" until the request settles.
          closeOnSelect={false}
          data-testid={`${resolvedTestId}-manage`}
          className="w-56"
        >
          <ActionMenuRowStyle>
            <MenuLabel>{manageHeader}</MenuLabel>
            <MenuDivider />
            <MenuItem
              onClick={(event): void =>
                openShareModal(event.currentTarget.ownerDocument)
              }
            >
              <MenuItemIcon>
                <ShareIcon />
              </MenuItemIcon>
              {RESHARE_LABEL}
            </MenuItem>
            <MenuItem
              onClick={openComments}
              data-testid={`${resolvedTestId}-comments`}
            >
              <MenuItemIcon>
                <MessageIcon />
              </MenuItemIcon>
              {commentsLabel(unreadComments)}
            </MenuItem>
            <MenuDivider />
            <MenuItem
              disabled={unsharing}
              onClick={handleUnshare}
              data-testid={`${resolvedTestId}-unshare`}
              tone="destructive"
            >
              <MenuItemIcon>
                <EyeOffIcon />
              </MenuItemIcon>
              {unsharing ? UNSHARING_LABEL : UNSHARE_LABEL}
            </MenuItem>
          </ActionMenuRowStyle>
        </Menu>
      )}

      {modal}
    </div>
  );
}
