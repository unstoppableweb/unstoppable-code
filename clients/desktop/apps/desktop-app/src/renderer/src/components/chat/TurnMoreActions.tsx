import { useState, type JSX } from 'react';
import type { SharedRunMetadata } from '@canopy/desktop-shared/types';
import {
  MenuDivider,
  MenuItem,
  MenuItemIcon,
  TurnMoreMenu,
} from '@canopy/ui-shared/components';
import { GitBranchLineIcon } from '@canopy/ui-shared/icons/AppIcons';
import { ShareRunModal } from '@/components/shared/ShareRunModal';
import { ShareSessionControl } from '@/components/shared/ShareSessionControl';
import { useShareRunAction } from '@/hooks/useShareRunAction';
import {
  TurnFeedbackControlHost,
  TurnFeedbackDialogHost,
  type TurnFeedbackTarget,
} from './TurnFeedbackHosts';

/**
 * The clean chat look's "•••" menu on a finished turn: Branch into a new
 * worktree, Share (with Run comments and Stop sharing once shared), then
 * Good response and Bad response, the same actions today's footer shows as
 * separate icons. The share and feedback dialogs live here, outside the
 * menu, so they stay open after the menu closes.
 */
export function TurnMoreActions({
  projectId,
  worktreeId,
  chatId,
  onBranch,
  share,
  feedback,
}: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  onBranch?: () => void;
  share?: {
    title: string;
    hasMessages: boolean;
    busy: boolean;
    sharedRun?: SharedRunMetadata;
  };
  /** Rate the turn: Good response / Bad response rows. */
  feedback?: { target: TurnFeedbackTarget; userMessageId: string };
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const shareAction = useShareRunAction(projectId, worktreeId);
  if (onBranch === undefined && share === undefined && feedback === undefined)
    return null;
  return (
    <>
      <TurnMoreMenu open={open} onOpenChange={setOpen}>
        {onBranch !== undefined && (
          <MenuItem
            data-testid="turn-more-branch"
            onClick={(): void => {
              setOpen(false);
              onBranch();
            }}
          >
            <MenuItemIcon>
              <GitBranchLineIcon aria-hidden="true" />
            </MenuItemIcon>
            Branch into a new worktree
          </MenuItem>
        )}
        {share !== undefined && (
          <ShareSessionControl
            variant="menu-item"
            projectId={projectId}
            worktreeId={worktreeId}
            chatId={chatId}
            title={share.title}
            hasMessages={share.hasMessages}
            busy={share.busy}
            {...(share.sharedRun ? { sharedRun: share.sharedRun } : {})}
            testId="turn-more-share"
            onAfterSelect={(): void => setOpen(false)}
            onOpenShare={(id, title, ownerDocument, existingShare): void => {
              shareAction.open(id, title, ownerDocument, existingShare);
            }}
          />
        )}
        {feedback !== undefined && (
          <>
            {(onBranch !== undefined || share !== undefined) && <MenuDivider />}
            <TurnFeedbackControlHost
              target={feedback.target}
              userMessageId={feedback.userMessageId}
              onRequestDetail={(): void => {
                setFeedbackDialogOpen(true);
              }}
            />
          </>
        )}
      </TurnMoreMenu>
      {shareAction.target && (
        <ShareRunModal
          chatId={shareAction.target.chatId}
          runTitle={shareAction.target.title}
          ownerDocument={shareAction.target.ownerDocument}
          existingShare={shareAction.target.existingShare}
          onClose={shareAction.close}
          onShare={shareAction.submit}
          checkEligibility={shareAction.checkEligibility}
          onShared={shareAction.onShared}
        />
      )}
      {feedback !== undefined && feedbackDialogOpen && (
        <TurnFeedbackDialogHost
          target={feedback.target}
          userMessageId={feedback.userMessageId}
          onClose={(): void => {
            setFeedbackDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
